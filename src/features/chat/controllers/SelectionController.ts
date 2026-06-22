import type { App, HeadingCache } from 'obsidian';
import { MarkdownView, TFile } from 'obsidian';

import { hideSelectionHighlight, showSelectionHighlight } from '../../../shared/components/SelectionHighlight';
import { type EditorSelectionContext, getEditorView } from '../../../utils/editor';
import { createPinnedSelectionId, type PinnedSelection } from '../../../utils/pinnedSelection';
import type { ChatState } from '../state/ChatState';
import type { StoredSelection } from '../state/types';
import { updateContextRowHasContent } from './contextRowVisibility';

const SELECTION_POLL_INTERVAL = 250;
const INPUT_HANDOFF_GRACE_MS = 1500;
const HIGHLIGHT_KEY = 'claudian-selection';

/**
 * Strips inline/block Markdown markup from a single line so that reading-mode
 * DOM text (which the renderer delivers without markup) can be matched against
 * raw source lines. Removes leading blockquote/list/heading markers, link
 * syntax, and emphasis/code/highlight delimiters, then collapses whitespace.
 */
function normalizeMarkdownLine(line: string): string {
  let s = line;
  // Leading blockquote markers (possibly nested: "> > ").
  while (/^\s*>/.test(s)) s = s.replace(/^\s*>\s?/, '');
  // Leading heading hashes.
  s = s.replace(/^\s*#{1,6}\s+/, '');
  // Leading list bullet / ordered marker.
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
  // Wikilinks [[target|display]] / [[target]] → display (or target).
  s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1');
  // Markdown links [text](url) → text.
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Inline emphasis / code / highlight / strikethrough delimiters.
  s = s.replace(/[*_=`~]/g, '');
  // Collapse whitespace.
  return s.replace(/\s+/g, ' ').trim();
}

type CustomHighlightRegistry = {
  delete: (name: string) => boolean;
  set: (name: string, highlight: unknown) => void;
};
type CustomHighlightConstructor = new (...ranges: Range[]) => unknown;

export class SelectionController {
  private app: App;
  private indicatorEl: HTMLElement;
  private inputEl: HTMLElement;
  private focusScopeEl: HTMLElement;
  private contextRowEl: HTMLElement;
  private onVisibilityChange: (() => void) | null;
  private storedSelection: StoredSelection | null = null;
  private inputHandoffGraceUntil: number | null = null;
  private pollInterval: number | null = null;
  private chatState: ChatState | null = null;
  private onSelectionPresenceChange: ((hasSelection: boolean) => void) | null = null;
  private readonly focusScopePointerDownHandler = () => {
    if (!this.storedSelection) return;
    this.inputHandoffGraceUntil = Date.now() + INPUT_HANDOFF_GRACE_MS;
  };

  constructor(
    app: App,
    indicatorEl: HTMLElement,
    inputEl: HTMLElement,
    contextRowEl: HTMLElement,
    onVisibilityChange?: () => void,
    focusScopeEl?: HTMLElement
  ) {
    this.app = app;
    this.indicatorEl = indicatorEl;
    this.inputEl = inputEl;
    this.focusScopeEl = focusScopeEl ?? inputEl;
    this.contextRowEl = contextRowEl;
    this.onVisibilityChange = onVisibilityChange ?? null;
  }

  start(): void {
    if (this.pollInterval) return;
    this.inputEl.addEventListener('pointerdown', this.focusScopePointerDownHandler);
    if (this.focusScopeEl !== this.inputEl) {
      this.focusScopeEl.addEventListener('pointerdown', this.focusScopePointerDownHandler);
    }
    this.pollInterval = window.setInterval(() => this.poll(), SELECTION_POLL_INTERVAL);
  }

  stop(): void {
    if (this.pollInterval) {
      window.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.inputEl.removeEventListener('pointerdown', this.focusScopePointerDownHandler);
    if (this.focusScopeEl !== this.inputEl) {
      this.focusScopeEl.removeEventListener('pointerdown', this.focusScopePointerDownHandler);
    }
    this.clear();
  }

  dispose(): void {
    this.stop();
  }

  // ============================================
  // Selection Polling
  // ============================================

  private poll(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      // Keep the captured selection only while focus is transitioning into
      // the chat UI; any other leaf switch should drop stale prompt context.
      this.clearWhenMarkdownContextIsUnavailable();
      return;
    }

    // Reading/preview mode has no usable CM6 selection — use DOM selection instead
    if (view.getMode() === 'preview') {
      this.pollReadingMode(view);
      return;
    }

    const editor = view.editor;
    const editorView = getEditorView(editor);
    if (!editorView) {
      this.clearWhenMarkdownContextIsUnavailable();
      return;
    }

    const selectedText = editor.getSelection();

    if (selectedText.trim()) {
      this.inputHandoffGraceUntil = null;
      const fromPos = editor.getCursor('from');
      const toPos = editor.getCursor('to');
      const from = editor.posToOffset(fromPos);
      const to = editor.posToOffset(toPos);
      const startLine = fromPos.line + 1; // 1-indexed for display

      const notePath = view.file?.path || 'unknown';
      const lineCount = selectedText.split(/\r?\n/).length;

      const s = this.storedSelection;
      const sameRange = s
        && s.editorView === editorView
        && s.from === from
        && s.to === to
        && s.notePath === notePath;
      const unchanged = sameRange
        && s.selectedText === selectedText
        && s.lineCount === lineCount
        && s.startLine === startLine;

      if (!unchanged) {
        if (s && !sameRange) {
          this.clearHighlight();
        }
        this.storedSelection = { notePath, selectedText, lineCount, startLine, from, to, editorView };
        this.updateIndicator();
      }
    } else {
      this.handleDeselection();
    }
  }

  private pollReadingMode(view: MarkdownView): void {
    const containerEl = view.containerEl;
    if (!containerEl) {
      this.clearWhenMarkdownContextIsUnavailable();
      return;
    }

    const selection = this.getDocumentSelection(containerEl.ownerDocument);
    const selectedText = selection?.toString() ?? '';

    if (selectedText.trim()) {
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      if (
        (!anchorNode || !containerEl.contains(anchorNode))
        && (!focusNode || !containerEl.contains(focusNode))
      ) {
        this.handleDeselection();
        return;
      }

      this.inputHandoffGraceUntil = null;
      const notePath = view.file?.path || 'unknown';
      const lineCount = selectedText.split(/\r?\n/).length;
      const domRanges = this.cloneDOMRanges(selection);

      const unchanged = this.storedSelection
        && this.storedSelection.editorView === undefined
        && this.storedSelection.notePath === notePath
        && this.storedSelection.selectedText === selectedText
        && this.storedSelection.lineCount === lineCount
        && this.rangeListsMatch(this.storedSelection.domRanges, domRanges);

      if (!unchanged) {
        this.clearHighlight();
        this.storedSelection = { notePath, selectedText, lineCount, domRanges };
        this.updateIndicator();
      }
    } else {
      this.handleDeselection();
    }
  }

  private get cssHighlights(): CustomHighlightRegistry | null {
    const css = typeof CSS === 'undefined'
      ? null
      : CSS as unknown as { highlights?: CustomHighlightRegistry };
    return css?.highlights ?? null;
  }

  private get highlightConstructor(): CustomHighlightConstructor | null {
    const ownerWindow = this.inputEl.ownerDocument.defaultView as unknown as {
      Highlight?: CustomHighlightConstructor;
    } | null;
    const rendererWindow = typeof window === 'undefined'
      ? null
      : window as unknown as { Highlight?: CustomHighlightConstructor };
    return ownerWindow?.Highlight ?? rendererWindow?.Highlight ?? null;
  }

  private rangesMatch(a: Range, b: Range): boolean {
    return a.startContainer === b.startContainer
      && a.startOffset === b.startOffset
      && a.endContainer === b.endContainer
      && a.endOffset === b.endOffset;
  }

  private rangeListsMatch(left: Range[] | undefined, right: Range[]): boolean {
    return left !== undefined
      && left.length === right.length
      && left.every((range, index) => this.rangesMatch(range, right[index]));
  }

  private selectionMatchesRanges(selection: Selection | null, ranges: Range[]): boolean {
    if (!selection || selection.rangeCount !== ranges.length) return false;
    for (let i = 0; i < ranges.length; i++) {
      if (!this.rangesMatch(selection.getRangeAt(i), ranges[i])) {
        return false;
      }
    }
    return true;
  }

  private cloneDOMRanges(selection: Selection | null): Range[] {
    if (!selection) return [];
    const ranges: Range[] = [];
    for (let i = 0; i < selection.rangeCount; i++) {
      ranges.push(selection.getRangeAt(i).cloneRange());
    }
    return ranges;
  }

  private getDocumentSelection(ownerDocument?: Document | null): Selection | null {
    if (ownerDocument && typeof ownerDocument.getSelection === 'function') {
      return ownerDocument.getSelection();
    }

    const fallbackDocument = this.inputEl.ownerDocument;
    if (fallbackDocument && typeof fallbackDocument.getSelection === 'function') {
      return fallbackDocument.getSelection();
    }

    return null;
  }

  private getActiveElement(ownerDocument?: Document | null): Element | null {
    return ownerDocument?.activeElement ?? this.inputEl.ownerDocument?.activeElement ?? null;
  }

  private isFocusWithinChatSidebar(): boolean {
    const activeElement = this.getActiveElement(this.focusScopeEl.ownerDocument) as Node | null;
    return activeElement !== null
      && (activeElement === this.focusScopeEl || this.focusScopeEl.contains(activeElement));
  }

  private isNativeEditorSelectionVisible(sel: StoredSelection): boolean {
    if (!sel.editorView || sel.from === undefined || sel.to === undefined) {
      return false;
    }

    const activeElement = this.getActiveElement(sel.editorView.dom.ownerDocument) as Node | null;
    if (activeElement === null || !sel.editorView.dom.contains(activeElement)) {
      return false;
    }

    const cmSel = sel.editorView.state.selection.main;
    return cmSel.from === sel.from && cmSel.to === sel.to;
  }

  private isNativePreviewSelectionVisible(ranges: Range[]): boolean {
    if (this.isFocusWithinChatSidebar()) {
      return false;
    }

    return this.selectionMatchesRanges(this.getDocumentSelection(this.focusScopeEl.ownerDocument), ranges);
  }

  private clearWhenMarkdownContextIsUnavailable(): void {
    if (!this.storedSelection) return;
    if (this.isFocusWithinChatSidebar()) {
      this.inputHandoffGraceUntil = null;
      return;
    }
    if (this.inputHandoffGraceUntil !== null && Date.now() <= this.inputHandoffGraceUntil) {
      return;
    }

    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }

  private handleDeselection(): void {
    if (!this.storedSelection) return;
    if (this.isFocusWithinChatSidebar()) {
      this.inputHandoffGraceUntil = null;
      return;
    }

    if (this.inputHandoffGraceUntil !== null && Date.now() <= this.inputHandoffGraceUntil) {
      return;
    }

    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }

  // ============================================
  // Highlight Management
  // ============================================

  showHighlight(): void {
    const sel = this.storedSelection;
    if (!sel) return;

    // Edit mode: prefer native CM6 unfocused selection (.cm-selectionBackground)
    if (sel.editorView && sel.from !== undefined && sel.to !== undefined) {
      if (this.isNativeEditorSelectionVisible(sel)) {
        // Native is showing — clear any stale mock
        hideSelectionHighlight(sel.editorView);
        return;
      }
      // Native selection not visible (e.g., input has focus) — show mock
      showSelectionHighlight(sel.editorView, sel.from, sel.to);
      return;
    }

    // Preview mode: prefer native DOM selection (::selection)
    if (sel.domRanges?.length) {
      if (this.isNativePreviewSelectionVisible(sel.domRanges)) {
        // Native is showing — clear any stale mock
        this.cssHighlights?.delete(HIGHLIGHT_KEY);
        return;
      }
      // Native selection not visible (e.g., input has focus) — show mock
      const validRanges = sel.domRanges.filter(r => r.startContainer.isConnected);
      const HighlightCtor = this.highlightConstructor;
      if (validRanges.length && HighlightCtor) {
        this.cssHighlights?.set(HIGHLIGHT_KEY, new HighlightCtor(...validRanges));
      }
    }
  }

  private clearHighlight(): void {
    if (this.storedSelection?.editorView) {
      hideSelectionHighlight(this.storedSelection.editorView);
    }
    this.cssHighlights?.delete(HIGHLIGHT_KEY);
  }

  // ============================================
  // Indicator
  // ============================================

  private updateIndicator(): void {
    if (!this.indicatorEl) return;

    if (this.storedSelection) {
      const lineText = this.storedSelection.lineCount === 1 ? 'line' : 'lines';
      this.indicatorEl.textContent = `${this.storedSelection.lineCount} ${lineText} selected`;
      this.indicatorEl.removeClass('claudian-hidden');
    } else {
      this.indicatorEl.addClass('claudian-hidden');
    }
    this.updateContextRowVisibility();
    this.onSelectionPresenceChange?.(this.storedSelection !== null);
  }

  updateContextRowVisibility(): void {
    if (!this.contextRowEl) return;
    updateContextRowHasContent(this.contextRowEl);
    this.onVisibilityChange?.();
  }

  // ============================================
  // Context Access
  // ============================================

  getContext(): EditorSelectionContext | null {
    if (!this.storedSelection) return null;
    return {
      notePath: this.storedSelection.notePath,
      mode: 'selection',
      selectedText: this.storedSelection.selectedText,
      lineCount: this.storedSelection.lineCount,
      ...(this.storedSelection.startLine !== undefined && { startLine: this.storedSelection.startLine }),
    };
  }

  hasSelection(): boolean {
    return this.storedSelection !== null;
  }

  // ============================================
  // Multi-selection fork: pinning API
  // ============================================

  /** Wire the chat state and a callback that fires whenever the active editor selection appears/disappears. */
  setMultiSelectionDeps(chatState: ChatState, onPresenceChange: (hasSelection: boolean) => void): void {
    this.chatState = chatState;
    this.onSelectionPresenceChange = onPresenceChange;
  }

  /**
   * Snapshot of the active selection enriched with the nearest Markdown heading.
   *
   * Edit mode: line numbers come straight from CodeMirror's cursor positions.
   * Reading/preview mode: CM6 cursor is unavailable, so we resolve line numbers
   * via a text match against the file contents (same fallback pattern that
   * `quote-for-ai` uses). Async so we can `vault.read` when needed.
   */
  async buildPinnedFromActive(): Promise<PinnedSelection | null> {
    const s = this.storedSelection;
    if (!s || !s.selectedText.trim()) return null;

    let startLine = s.startLine;
    let lineCount = s.lineCount;

    // Preview mode (or any case where editor didn't supply a line) — derive
    // start/end via text match against the file. Keeps `lines` accurate so
    // Claude can Read(offset, limit) without re-searching.
    if (startLine === undefined) {
      const derived = await this.deriveLinesFromContent(s.notePath, s.selectedText);
      if (derived) {
        startLine = derived.startLine;
        lineCount = derived.lineCount;
      } else {
        startLine = 1;
      }
    }

    const endLine = startLine + lineCount - 1;
    const heading = this.findEnclosingHeading(s.notePath, startLine);

    return {
      id: createPinnedSelectionId(),
      notePath: s.notePath,
      startLine,
      endLine,
      heading,
      selectedText: s.selectedText,
      comment: '',
    };
  }

  async pinActiveSelection(): Promise<PinnedSelection | null> {
    const state = this.chatState;
    if (!state) return null;
    const pin = await this.buildPinnedFromActive();
    if (!pin) return null;
    state.addPinnedSelection(pin);
    return pin;
  }

  /**
   * Reads the file and resolves the selection's true 1-indexed start line + line
   * count.
   *
   * Why this is non-trivial: in reading/preview mode the DOM `Selection` returns
   * *rendered* text with Markdown markup stripped — `- ==creates==` becomes
   * `creates`, `**bold**` becomes `bold`, `` `code` `` becomes `code`, list
   * bullets and heading hashes vanish. A raw `content.indexOf(selectedText)`
   * therefore fails on any line that has formatting, and the old code fell back
   * to line 1 — so every pin showed `lines="1-N"`.
   *
   * Strategy:
   *   1. Fast path — exact substring match (works for code blocks / verbatim
   *      text that the renderer leaves untouched).
   *   2. Markdown-aware match — normalize every source line (strip markup) and
   *      match the normalized selection lines against them. Source line must
   *      *contain* the selection line, which is robust to the renderer dropping
   *      trailing punctuation/whitespace.
   */
  private async deriveLinesFromContent(
    notePath: string,
    selectedText: string,
  ): Promise<{ startLine: number; lineCount: number } | null> {
    if (!notePath || notePath === 'unknown') return null;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return null;

    let content: string;
    try {
      content = await this.app.vault.read(file);
    } catch {
      return null;
    }

    // 1. Fast path: verbatim substring (code, unformatted text).
    const trimmed = selectedText.trim();
    const exactIdx = trimmed ? content.indexOf(trimmed) : -1;
    if (exactIdx !== -1) {
      const startLine = content.slice(0, exactIdx).split('\n').length;
      const endIdx = Math.min(exactIdx + trimmed.length, content.length);
      const endLine = content.slice(0, endIdx).split('\n').length;
      return { startLine, lineCount: Math.max(1, endLine - startLine + 1) };
    }

    // 2. Markdown-aware, line-based match.
    const normSource = content.split('\n').map((l) => normalizeMarkdownLine(l));
    const selNorm = selectedText
      .split(/\r?\n/)
      .map((l) => normalizeMarkdownLine(l))
      .filter((l) => l.length > 0);
    if (selNorm.length === 0) return null;

    // Source line (normalized) must contain the selection line (normalized).
    const lineMatches = (source: string, target: string): boolean =>
      target.length > 0 && (source === target || source.includes(target));

    if (selNorm.length > 1) {
      // Contiguous block: N consecutive source lines matching N selection lines.
      for (let i = 0; i + selNorm.length <= normSource.length; i++) {
        let ok = true;
        for (let j = 0; j < selNorm.length; j++) {
          if (!lineMatches(normSource[i + j], selNorm[j])) { ok = false; break; }
        }
        if (ok) return { startLine: i + 1, lineCount: selNorm.length };
      }
      // Looser: anchor on the first selection line, extend to the last match.
      const startIdx = normSource.findIndex((l) => lineMatches(l, selNorm[0]));
      if (startIdx !== -1) {
        let endIdx = startIdx;
        for (let k = normSource.length - 1; k >= startIdx; k--) {
          if (lineMatches(normSource[k], selNorm[selNorm.length - 1])) { endIdx = k; break; }
        }
        return { startLine: startIdx + 1, lineCount: Math.max(1, endIdx - startIdx + 1) };
      }
      return null;
    }

    // Single-line selection: first source line that contains it.
    const idx = normSource.findIndex((l) => lineMatches(l, selNorm[0]));
    if (idx !== -1) return { startLine: idx + 1, lineCount: 1 };
    return null;
  }

  private findEnclosingHeading(notePath: string, startLine1Indexed: number): string {
    if (!notePath || notePath === 'unknown') return '';
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return '';
    const cache = this.app.metadataCache.getFileCache(file);
    const headings = cache?.headings;
    if (!headings || headings.length === 0) return '';
    const startLine0Indexed = startLine1Indexed - 1;
    let best: HeadingCache | null = null;
    for (const h of headings) {
      if (h.position.start.line <= startLine0Indexed) {
        best = h;
      } else {
        break;
      }
    }
    return best?.heading ?? '';
  }

  // ============================================
  // Clear
  // ============================================

  clear(): void {
    this.inputHandoffGraceUntil = null;
    this.clearHighlight();
    this.storedSelection = null;
    this.updateIndicator();
  }
}
