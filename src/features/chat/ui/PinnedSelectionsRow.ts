/**
 * Claudian Multi-Selection Fork - Pinned Selections Row
 *
 * Renders pinned editor selections as chips above the chat input. Each chip
 * shows: snippet (first ~80 chars), file path + line range, expand/collapse
 * toggle, X to remove. Expanded state reveals a per-chip comment textarea.
 *
 * Subscribes to ChatState.onPinnedSelectionsChanged (wired in Tab.ts) and
 * re-renders the whole list on each update. Single-source-of-truth: state.
 */

import type { App} from 'obsidian';
import { setIcon, TFile } from 'obsidian';

import { makeSnippet, type PinnedSelection } from '../../../utils/pinnedSelection';
import type { ChatState } from '../state/ChatState';

const COMMENT_PLACEHOLDER = 'Комментарий к этому фрагменту (необязательно)…';

interface CommentFocusSnapshot {
  id: string;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
}

export class PinnedSelectionsRow {
  private app: App;
  private chatState: ChatState;
  private rootEl: HTMLElement;
  private onChange: () => void;
  private expanded: Set<string> = new Set();
  /** Id of a chip that was JUST expanded (via toggle) and deserves auto-focus on next render. */
  private justExpandedId: string | null = null;
  /** When true, hide the chip list and only show the header (count + clear). */
  private isListCollapsed = false;

  constructor(app: App, chatState: ChatState, rootEl: HTMLElement, onChange: () => void) {
    this.app = app;
    this.chatState = chatState;
    this.onChange = onChange;
    this.rootEl = rootEl;
    this.rootEl.addClass('claudian-pinned-row');
    this.rootEl.addClass('claudian-hidden');
    this.render(chatState.pinnedSelections);
  }

  /** Re-render the chip list from the current state. */
  render(selections: PinnedSelection[]): void {
    // Snapshot the caret of the focused comment textarea BEFORE we wipe the DOM —
    // otherwise the new textarea created by empty()/createEl gets cursor=end on
    // every keystroke, which jumps the user to the end of the comment mid-edit.
    const focusSnapshot = this.captureCommentFocus();
    const justExpanded = this.justExpandedId;
    this.justExpandedId = null;

    this.rootEl.empty();
    if (selections.length === 0) {
      this.rootEl.addClass('claudian-hidden');
      this.rootEl.removeClass('claudian-pinned-row--collapsed');
      this.onChange();
      return;
    }
    this.rootEl.removeClass('claudian-hidden');
    if (this.isListCollapsed) this.rootEl.addClass('claudian-pinned-row--collapsed');
    else this.rootEl.removeClass('claudian-pinned-row--collapsed');

    const header = this.rootEl.createDiv({ cls: 'claudian-pinned-row__header' });

    // Chevron: collapses/expands the whole chip list.
    const collapseBtn = header.createEl('button', {
      cls: 'claudian-pinned-row__collapse',
      attr: {
        type: 'button',
        'aria-label': this.isListCollapsed ? 'Развернуть список' : 'Свернуть список',
        title: this.isListCollapsed ? 'Развернуть' : 'Свернуть',
      },
    });
    setIcon(collapseBtn, this.isListCollapsed ? 'chevron-right' : 'chevron-down');

    const title = header.createSpan({
      cls: 'claudian-pinned-row__title',
      text: `Прикреплено: ${selections.length}`,
    });

    // Whole header (chevron + title area) toggles collapse; spacer fills middle so
    // the trash button stays right-aligned without conflicting with the click target.
    const spacer = header.createDiv({ cls: 'claudian-pinned-row__spacer' });

    const toggleCollapsed = (e: Event) => {
      e.stopPropagation();
      this.isListCollapsed = !this.isListCollapsed;
      this.render(this.chatState.pinnedSelections);
    };
    collapseBtn.addEventListener('click', toggleCollapsed);
    title.addEventListener('click', toggleCollapsed);
    spacer.addEventListener('click', toggleCollapsed);

    const clearBtn = header.createEl('button', {
      cls: 'claudian-pinned-row__clear',
      attr: { type: 'button', 'aria-label': 'Убрать все', title: 'Убрать все' },
    });
    setIcon(clearBtn, 'trash-2');
    clearBtn.addEventListener('click', (e) => {
      // Don't let the click bubble to the collapse handlers above.
      e.stopPropagation();
      this.chatState.clearPinnedSelections();
    });

    // Skip rendering chips entirely when collapsed — faster, and means caret
    // restoration / chip expand state are preserved logically (in this.expanded)
    // for when the user reopens the list.
    if (!this.isListCollapsed) {
      selections.forEach((sel, idx) => this.renderChip(sel, idx + 1));
    }

    // Restore caret (mid-edit case) or auto-focus a freshly-expanded chip.
    // Snapshot wins because it means the user is actively typing.
    if (focusSnapshot) {
      this.restoreCommentFocus(focusSnapshot);
    } else if (justExpanded) {
      this.focusCommentForChip(justExpanded);
    }

    this.onChange();
  }

  dispose(): void {
    this.rootEl.remove();
  }

  /**
   * Expand a chip's comment field and focus it. Called by the floating
   * "attach + comment" button so the user can type a comment immediately
   * after pinning, without hunting for the chip and clicking its toggle.
   */
  expandForComment(id: string): void {
    // A collapsed list hides all chips — open it so the field is visible.
    this.isListCollapsed = false;
    this.expanded.add(id);
    this.justExpandedId = id;
    this.render(this.chatState.pinnedSelections);
  }

  // ============================================
  // Chip rendering
  // ============================================

  private renderChip(sel: PinnedSelection, ordinal: number): void {
    const chip = this.rootEl.createDiv({ cls: 'claudian-pinned-chip' });
    chip.dataset.pinnedId = sel.id;
    const isExpanded = this.expanded.has(sel.id);
    if (isExpanded) chip.addClass('claudian-pinned-chip--expanded');
    if (sel.comment.trim()) chip.addClass('claudian-pinned-chip--has-comment');

    const head = chip.createDiv({ cls: 'claudian-pinned-chip__head' });

    const ordinalBadge = head.createSpan({ cls: 'claudian-pinned-chip__ordinal', text: `[${ordinal}]` });
    ordinalBadge.title = `id="${sel.id}"`;

    const body = head.createDiv({ cls: 'claudian-pinned-chip__body' });

    const snippetEl = body.createDiv({ cls: 'claudian-pinned-chip__snippet', text: makeSnippet(sel.selectedText) });
    snippetEl.title = sel.selectedText;
    snippetEl.addEventListener('click', () => this.openNoteAtSelection(sel));

    const meta = body.createDiv({ cls: 'claudian-pinned-chip__meta' });
    const filename = sel.notePath.split('/').pop() ?? sel.notePath;
    const lineRange = sel.startLine === sel.endLine
      ? `:${sel.startLine}`
      : `:${sel.startLine}-${sel.endLine}`;
    meta.createSpan({ cls: 'claudian-pinned-chip__path', text: `${filename}${lineRange}` });
    if (sel.heading) {
      meta.createSpan({ cls: 'claudian-pinned-chip__heading', text: ` · ${sel.heading}` });
    }

    const actions = head.createDiv({ cls: 'claudian-pinned-chip__actions' });

    const expandBtn = actions.createEl('button', {
      cls: 'claudian-pinned-chip__action',
      attr: { type: 'button', 'aria-label': isExpanded ? 'Свернуть' : 'Развернуть для комментария' },
    });
    expandBtn.title = isExpanded ? 'Свернуть' : 'Добавить комментарий';
    setIcon(expandBtn, isExpanded ? 'chevron-up' : 'message-square');
    if (sel.comment.trim()) expandBtn.addClass('claudian-pinned-chip__action--active');
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleExpand(sel.id);
    });

    const removeBtn = actions.createEl('button', {
      cls: 'claudian-pinned-chip__action',
      attr: { type: 'button', 'aria-label': 'Убрать фрагмент', title: 'Убрать' },
    });
    setIcon(removeBtn, 'x');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.expanded.delete(sel.id);
      this.chatState.removePinnedSelection(sel.id);
    });

    if (isExpanded) {
      const commentEl = chip.createEl('textarea', {
        cls: 'claudian-pinned-chip__comment',
        attr: { placeholder: COMMENT_PLACEHOLDER, rows: '2' },
      });
      commentEl.value = sel.comment;
      commentEl.addEventListener('input', () => {
        this.chatState.updatePinnedSelectionComment(sel.id, commentEl.value);
      });
      // Focus is restored centrally in render() — either via captureCommentFocus
      // (mid-edit caret preservation) or via justExpandedId (initial expand).
    }
  }

  private toggleExpand(id: string): void {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      this.justExpandedId = id;
    }
    this.render(this.chatState.pinnedSelections);
  }

  // ============================================
  // Caret preservation across re-renders
  // ============================================

  private captureCommentFocus(): CommentFocusSnapshot | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) return null;
    if (!active.classList.contains('claudian-pinned-chip__comment')) return null;
    const chipEl = active.closest('.claudian-pinned-chip') as HTMLElement | null;
    const id = chipEl?.dataset.pinnedId;
    if (!id) return null;
    return {
      id,
      selectionStart: active.selectionStart ?? active.value.length,
      selectionEnd: active.selectionEnd ?? active.value.length,
      scrollTop: active.scrollTop,
    };
  }

  private restoreCommentFocus(snap: CommentFocusSnapshot): void {
    const textarea = this.findCommentTextarea(snap.id);
    if (!textarea) return;
    textarea.focus();
    // setSelectionRange after focus — order matters; focus() can reset selection
    // on some browsers if called afterwards.
    try {
      textarea.setSelectionRange(snap.selectionStart, snap.selectionEnd);
    } catch {
      // Some browsers throw on setSelectionRange for unattached/hidden elements.
      // Caret position is a nicety; don't crash the render path over it.
    }
    textarea.scrollTop = snap.scrollTop;
  }

  private focusCommentForChip(id: string): void {
    const textarea = this.findCommentTextarea(id);
    if (!textarea) return;
    // setTimeout because Obsidian may steal focus during the same tick when
    // a panel/leaf transition is happening (e.g. just after toggling expand).
    window.setTimeout(() => textarea.focus(), 0);
  }

  private findCommentTextarea(pinnedId: string): HTMLTextAreaElement | null {
    const escaped = window.CSS && typeof window.CSS.escape === 'function'
      ? window.CSS.escape(pinnedId)
      : pinnedId.replace(/"/g, '\\"');
    const chip = this.rootEl.querySelector(`.claudian-pinned-chip[data-pinned-id="${escaped}"]`);
    return (chip?.querySelector('.claudian-pinned-chip__comment') as HTMLTextAreaElement | null) ?? null;
  }

  private openNoteAtSelection(sel: PinnedSelection): void {
    const file = this.app.vault.getAbstractFileByPath(sel.notePath);
    if (!(file instanceof TFile)) return;
    this.app.workspace.openLinkText(sel.notePath, '', false).then(() => {
      const leaf = this.app.workspace.activeLeaf;
      const view = leaf?.view as { editor?: { setCursor: (pos: { line: number; ch: number }) => void; scrollIntoView: (range: { from: { line: number; ch: number }; to: { line: number; ch: number } }, center?: boolean) => void } };
      const editor = view?.editor;
      if (editor) {
        const from = { line: sel.startLine - 1, ch: 0 };
        const to = { line: sel.endLine - 1, ch: 0 };
        editor.setCursor(from);
        editor.scrollIntoView({ from, to }, true);
      }
    });
  }
}
