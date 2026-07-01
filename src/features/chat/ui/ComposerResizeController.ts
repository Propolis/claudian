/**
 * Claudian Multi-Selection Fork — Composer resize / collapse
 *
 * Adds a drag handle at the top edge of the composer. Behaviour:
 *   - Drag up/down → set a fixed composer height (content scrolls inside instead
 *     of the box growing over the chat).
 *   - Drag (or tap) all the way down → collapse the composer entirely, leaving
 *     only the chat. A tap on the slim handle restores it.
 *   - Double-nothing: a plain tap toggles collapse; a drag resizes.
 *
 * State (height + collapsed) is persisted globally in settings so it survives
 * reloads and applies to every tab.
 *
 * Interaction with auto-resize: setting a manual height marks the textarea with
 * data-manual-height, which makes autoResizeTextarea() a no-op — so the box
 * stays exactly where the user put it.
 */

import { autoResizeTextarea } from './textareaResize';

// Min height keeps a usable textarea visible above the toolbar/context chrome
// (~76px), so the typing area never collapses to zero at the smallest drag.
const COMPOSER_MIN_HEIGHT = 96;       // smallest fixed box height before collapse
const COMPOSER_COLLAPSE_AT = 56;      // dragging below this collapses
const COMPOSER_RESTORE_HEIGHT = 150;  // height used when restoring from collapse
const COMPOSER_MAX_FRACTION = 0.8;    // cap at 80% of the view height
const CLICK_MOVE_THRESHOLD = 4;       // px of movement below which it's a tap, not a drag

interface ComposerResizeSettings {
  composerHeight?: number | null;
  composerCollapsed?: boolean;
}

export interface ComposerResizeDeps {
  getSettings: () => ComposerResizeSettings;
  saveSettings: () => void;
}

export class ComposerResizeController {
  private handleEl: HTMLElement;
  private containerEl: HTMLElement;
  private wrapperEl: HTMLElement;
  private textareaEl: HTMLTextAreaElement;
  private deps: ComposerResizeDeps;

  private dragging = false;
  private pointerId: number | null = null;
  private startY = 0;
  private startHeight = 0;
  private moved = 0;
  private dragCollapsed = false;
  private dragHeight: number | null = null;
  private startedCollapsed = false;

  private readonly onPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
  private readonly onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private readonly onPointerUp = () => this.handlePointerUp();

  constructor(
    handleEl: HTMLElement,
    containerEl: HTMLElement,
    wrapperEl: HTMLElement,
    textareaEl: HTMLTextAreaElement,
    deps: ComposerResizeDeps,
  ) {
    this.handleEl = handleEl;
    this.containerEl = containerEl;
    this.wrapperEl = wrapperEl;
    this.textareaEl = textareaEl;
    this.deps = deps;

    this.handleEl.addEventListener('pointerdown', this.onPointerDown);
    this.applyState();
  }

  dispose(): void {
    // If disposed mid-drag, release capture + drop the global cursor/select lock
    // so it doesn't leak onto the whole app.
    this.endDragCleanup();
    this.handleEl.removeEventListener('pointerdown', this.onPointerDown);
  }

  /** Re-apply persisted height/collapsed state (construct + tab switch). */
  applyState(): void {
    const s = this.deps.getSettings();
    if (s.composerCollapsed) {
      this.containerEl.addClass('claudian-composer-collapsed');
      return;
    }
    this.containerEl.removeClass('claudian-composer-collapsed');
    // Only apply a stored height that is actually usable; anything smaller
    // (stale/hand-edited) falls back to auto — matching the restore guard.
    if (typeof s.composerHeight === 'number' && s.composerHeight >= COMPOSER_MIN_HEIGHT) {
      this.applyManualHeight(s.composerHeight);
    } else {
      this.clearManualHeight();
    }
  }

  /** Tears down the active drag: listeners, pointer capture, global cursor lock. */
  private endDragCleanup(): void {
    if (!this.dragging && this.pointerId === null) return;
    this.dragging = false;
    this.handleEl.removeEventListener('pointermove', this.onPointerMove);
    this.handleEl.removeEventListener('pointerup', this.onPointerUp);
    this.handleEl.removeEventListener('pointercancel', this.onPointerUp);
    try {
      if (this.pointerId !== null) this.handleEl.releasePointerCapture(this.pointerId);
    } catch { /* ignore */ }
    this.pointerId = null;
    this.containerEl.ownerDocument.body.removeClass('claudian-composer-resizing');
  }

  // ============================================
  // Height application
  // ============================================

  private applyManualHeight(h: number): void {
    this.wrapperEl.setCssStyles({ height: `${h}px`, minHeight: '0px' });
    this.textareaEl.dataset.manualHeight = String(h);
    // Let the textarea flex-fill the fixed wrapper; content scrolls inside.
    this.textareaEl.setCssProps({
      '--claudian-textarea-min-height': '0px',
      '--claudian-textarea-max-height': 'none',
    });
  }

  /** Remove the inline height / dataset / CSS-var overrides (no auto-resize). */
  private resetToAutoArtifacts(): void {
    // Empty string removes the inline override, restoring the stylesheet value.
    this.wrapperEl.setCssStyles({ height: '', minHeight: '' });
    delete this.textareaEl.dataset.manualHeight;
    this.textareaEl.setCssProps({
      '--claudian-textarea-min-height': '',
      '--claudian-textarea-max-height': '',
    });
  }

  private clearManualHeight(): void {
    this.resetToAutoArtifacts();
    autoResizeTextarea(this.textareaEl);
  }

  private maxHeight(): number {
    const view = this.containerEl.closest('.claudian-container')?.clientHeight ?? window.innerHeight;
    return Math.max(COMPOSER_MIN_HEIGHT, view * COMPOSER_MAX_FRACTION);
  }

  // ============================================
  // Pointer drag
  // ============================================

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.dragging = true;
    this.pointerId = e.pointerId;
    this.startY = e.clientY;
    this.moved = 0;
    const collapsed = this.containerEl.hasClass('claudian-composer-collapsed');
    this.startedCollapsed = collapsed;
    this.startHeight = collapsed ? 0 : this.wrapperEl.offsetHeight;
    this.dragCollapsed = collapsed;
    this.dragHeight = collapsed ? null : this.startHeight;

    try { this.handleEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.handleEl.addEventListener('pointermove', this.onPointerMove);
    this.handleEl.addEventListener('pointerup', this.onPointerUp);
    this.handleEl.addEventListener('pointercancel', this.onPointerUp);
    this.containerEl.ownerDocument.body.addClass('claudian-composer-resizing');
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    const delta = this.startY - e.clientY; // drag up → positive → taller
    this.moved = Math.max(this.moved, Math.abs(e.clientY - this.startY));

    // Starting from a collapsed composer: any upward pull past the tap threshold
    // opens it (from the min height and growing), so it's not a dead gesture.
    if (this.startedCollapsed) {
      if (delta <= CLICK_MOVE_THRESHOLD) {
        this.dragCollapsed = true; // still basically collapsed; up = tap-restore
        return;
      }
      const h = Math.min(COMPOSER_MIN_HEIGHT + (delta - CLICK_MOVE_THRESHOLD), this.maxHeight());
      this.dragCollapsed = false;
      this.dragHeight = h;
      this.containerEl.removeClass('claudian-composer-collapsed');
      this.applyManualHeight(h);
      return;
    }

    const h = this.startHeight + delta;
    if (h < COMPOSER_COLLAPSE_AT) {
      // Preview collapse — also drop the manual-height artifacts so state stays
      // consistent (no stale inline height / data-manual-height once collapsed).
      this.dragCollapsed = true;
      this.resetToAutoArtifacts();
      this.containerEl.addClass('claudian-composer-collapsed');
      return;
    }

    const clamped = Math.min(Math.max(h, COMPOSER_MIN_HEIGHT), this.maxHeight());
    this.dragCollapsed = false;
    this.dragHeight = clamped;
    this.containerEl.removeClass('claudian-composer-collapsed');
    this.applyManualHeight(clamped);
  }

  private handlePointerUp(): void {
    if (!this.dragging) return;
    this.endDragCleanup();

    // A tap (negligible movement) toggles collapse instead of resizing.
    if (this.moved < CLICK_MOVE_THRESHOLD) {
      this.toggleCollapsed();
      return;
    }

    // Persist the drag result.
    const s = this.deps.getSettings();
    if (this.dragCollapsed) {
      s.composerCollapsed = true;
      // Keep the last healthy height for restore.
    } else {
      s.composerCollapsed = false;
      s.composerHeight = this.dragHeight ?? null;
    }
    this.deps.saveSettings();
  }

  private toggleCollapsed(): void {
    const s = this.deps.getSettings();
    const nowCollapsed = this.containerEl.hasClass('claudian-composer-collapsed');
    if (nowCollapsed) {
      // Restore. Use a visible height; bump tiny/absent heights up.
      this.containerEl.removeClass('claudian-composer-collapsed');
      s.composerCollapsed = false;
      if (typeof s.composerHeight === 'number' && s.composerHeight >= COMPOSER_MIN_HEIGHT) {
        this.applyManualHeight(s.composerHeight);
      } else {
        // Was auto (null) — go back to auto; or bump a tiny stored height.
        if (s.composerHeight == null) {
          this.clearManualHeight();
        } else {
          s.composerHeight = COMPOSER_RESTORE_HEIGHT;
          this.applyManualHeight(COMPOSER_RESTORE_HEIGHT);
        }
      }
    } else {
      this.containerEl.addClass('claudian-composer-collapsed');
      s.composerCollapsed = true;
    }
    this.deps.saveSettings();
  }
}
