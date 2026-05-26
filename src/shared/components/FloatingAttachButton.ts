/**
 * Claudian Multi-Selection Fork - Floating "Attach to chat" button
 *
 * A floating DOM button that appears just above the end of the active editor
 * selection (edit or preview mode). Clicking it captures the selection — with
 * nearest Markdown heading from the metadata cache — and pushes it into
 * ChatState.pinnedSelections.
 *
 * Lives at the app level (singleton per tab). Visibility is driven by
 * SelectionController calling `setVisible(true/false)` from its presence
 * callback; positioning recomputes on scroll and on every selection change.
 */

import type { App } from 'obsidian';
import { MarkdownView, setIcon } from 'obsidian';

import type { SelectionController } from '../../features/chat/controllers/SelectionController';

const REPOSITION_INTERVAL_MS = 100;
const BUTTON_OFFSET_Y = 8;
const BUTTON_LABEL = 'Прикрепить к чату';

export class FloatingAttachButton {
  private app: App;
  private selectionController: SelectionController;
  private buttonEl: HTMLButtonElement;
  private visible = false;
  private repositionInterval: number | null = null;
  private scrollHandler: (() => void) | null = null;

  constructor(app: App, selectionController: SelectionController) {
    this.app = app;
    this.selectionController = selectionController;

    this.buttonEl = this.createButton();
    activeDocument.body.appendChild(this.buttonEl);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      this.buttonEl.removeClass('claudian-hidden');
      this.reposition();
      this.startRepositionLoop();
    } else {
      this.buttonEl.addClass('claudian-hidden');
      this.stopRepositionLoop();
    }
  }

  dispose(): void {
    this.stopRepositionLoop();
    this.buttonEl.remove();
  }

  // ============================================
  // Internals
  // ============================================

  private createButton(): HTMLButtonElement {
    const btn = activeDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'claudian-floating-attach-btn claudian-hidden';
    btn.setAttribute('aria-label', BUTTON_LABEL);
    btn.title = BUTTON_LABEL;

    const iconEl = activeDocument.createElement('span');
    iconEl.className = 'claudian-floating-attach-btn__icon';
    setIcon(iconEl, 'paperclip');

    const labelEl = activeDocument.createElement('span');
    labelEl.className = 'claudian-floating-attach-btn__label';
    labelEl.textContent = BUTTON_LABEL;

    btn.appendChild(iconEl);
    btn.appendChild(labelEl);

    btn.addEventListener('mousedown', (e) => {
      // Prevent the editor from losing its selection before we can capture it.
      e.preventDefault();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleClick();
    });

    return btn;
  }

  private handleClick(): void {
    const pin = this.selectionController.pinActiveSelection();
    if (!pin) return;
    // Visual feedback — brief pulse.
    this.buttonEl.addClass('claudian-floating-attach-btn--pulse');
    window.setTimeout(() => {
      this.buttonEl.removeClass('claudian-floating-attach-btn--pulse');
    }, 280);
  }

  private startRepositionLoop(): void {
    if (this.repositionInterval !== null) return;
    this.repositionInterval = window.setInterval(() => this.reposition(), REPOSITION_INTERVAL_MS);
    this.scrollHandler = () => this.reposition();
    window.addEventListener('scroll', this.scrollHandler, true);
  }

  private stopRepositionLoop(): void {
    if (this.repositionInterval !== null) {
      window.clearInterval(this.repositionInterval);
      this.repositionInterval = null;
    }
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler, true);
      this.scrollHandler = null;
    }
  }

  private reposition(): void {
    const anchor = this.computeAnchor();
    if (!anchor) {
      this.buttonEl.addClass('claudian-hidden');
      return;
    }

    this.buttonEl.removeClass('claudian-hidden');

    const btnRect = this.buttonEl.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Anchor below the end of the selection, right-aligned to selection end.
    let top = anchor.bottom + BUTTON_OFFSET_Y;
    let left = anchor.right - btnRect.width;

    // Flip above if no room below.
    if (top + btnRect.height > viewportH - 4) {
      top = anchor.top - btnRect.height - BUTTON_OFFSET_Y;
    }

    // Clamp to viewport.
    top = Math.max(4, Math.min(top, viewportH - btnRect.height - 4));
    left = Math.max(4, Math.min(left, viewportW - btnRect.width - 4));

    this.buttonEl.style.top = `${top}px`;
    this.buttonEl.style.left = `${left}px`;
  }

  /**
   * Returns the bounding rect of the end of the current selection in the
   * active Markdown view, or null when no usable selection exists.
   */
  private computeAnchor(): DOMRect | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;

    // Reading mode → use DOM selection.
    if (view.getMode() === 'preview') {
      const sel = view.containerEl.ownerDocument.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const last = sel.getRangeAt(sel.rangeCount - 1);
      const rects = last.getClientRects();
      if (rects.length === 0) return null;
      return rects[rects.length - 1];
    }

    // Edit mode → use CM6 coordsAtPos.
    const editor = view.editor;
    const fromPos = editor.getCursor('from');
    const toPos = editor.getCursor('to');
    if (fromPos.line === toPos.line && fromPos.ch === toPos.ch) return null;

    // @ts-expect-error - access internal `.cm` like the rest of the codebase
    const cm = editor.cm as { coordsAtPos: (pos: number) => { top: number; bottom: number; left: number; right: number } | null } | undefined;
    if (!cm) return null;

    const offset = editor.posToOffset(toPos);
    const coords = cm.coordsAtPos(offset);
    if (!coords) return null;

    return new DOMRect(coords.left, coords.top, coords.right - coords.left, coords.bottom - coords.top);
  }
}
