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

export class PinnedSelectionsRow {
  private app: App;
  private chatState: ChatState;
  private rootEl: HTMLElement;
  private onChange: () => void;
  private expanded: Set<string> = new Set();

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
    this.rootEl.empty();
    if (selections.length === 0) {
      this.rootEl.addClass('claudian-hidden');
      this.onChange();
      return;
    }
    this.rootEl.removeClass('claudian-hidden');

    const header = this.rootEl.createDiv({ cls: 'claudian-pinned-row__header' });
    header.createSpan({ cls: 'claudian-pinned-row__title', text: `Прикреплено: ${selections.length}` });
    const clearBtn = header.createEl('button', {
      cls: 'claudian-pinned-row__clear',
      attr: { type: 'button', 'aria-label': 'Убрать все', title: 'Убрать все' },
    });
    setIcon(clearBtn, 'trash-2');
    clearBtn.addEventListener('click', () => {
      this.chatState.clearPinnedSelections();
    });

    selections.forEach((sel, idx) => this.renderChip(sel, idx + 1));
    this.onChange();
  }

  dispose(): void {
    this.rootEl.remove();
  }

  // ============================================
  // Chip rendering
  // ============================================

  private renderChip(sel: PinnedSelection, ordinal: number): void {
    const chip = this.rootEl.createDiv({ cls: 'claudian-pinned-chip' });
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
      // Auto-focus when newly expanded
      window.setTimeout(() => commentEl.focus(), 0);
    }
  }

  private toggleExpand(id: string): void {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
    }
    this.render(this.chatState.pinnedSelections);
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
