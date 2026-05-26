/**
 * Claudian - Resume session dropdown
 *
 * Dropup UI for selecting a previous conversation to resume.
 * Shown when the /resume built-in command is executed.
 *
 * Multi-selection fork additions:
 *   - Search input filters by title substring (case-insensitive).
 *   - Sessions grouped by Desktop's `chromeTabGroupId` with section headers.
 *   - Archived (soft-deleted in Desktop) sessions hidden by default; toggle to show.
 *   - Refresh button re-scans external CLI session paths + Desktop metadata.
 */

import { setIcon } from 'obsidian';

import type { ExternalConversationMeta } from '../../app/services/ExternalSessionsDiscovery';
import type { ConversationMeta } from '../../core/types';

function isExternal(meta: ConversationMeta): meta is ExternalConversationMeta {
  return (meta as { external?: boolean }).external === true;
}

function getGroupId(meta: ConversationMeta): string | null {
  if (!isExternal(meta)) return null;
  return meta.groupId ?? null;
}

function isArchived(meta: ConversationMeta): boolean {
  if (!isExternal(meta)) return false;
  return meta.isArchived === true;
}

export interface ResumeSessionDropdownCallbacks {
  onSelect: (conversationId: string) => void;
  onDismiss: () => void;
  /** Multi-selection fork: re-scan external session paths and re-render with the latest list. */
  onRefresh?: () => ConversationMeta[];
}

export class ResumeSessionDropdown {
  private containerEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private dropdownEl: HTMLElement;
  private callbacks: ResumeSessionDropdownCallbacks;
  private conversations: ConversationMeta[];
  private currentConversationId: string | null;
  private selectedIndex = 0;
  // Multi-selection fork state:
  private searchQuery = '';
  private showArchived = false;
  /** Items currently rendered (after filter + sort), in display order. */
  private visibleConversations: ConversationMeta[] = [];
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    inputEl: HTMLTextAreaElement,
    conversations: ConversationMeta[],
    currentConversationId: string | null,
    callbacks: ResumeSessionDropdownCallbacks
  ) {
    this.containerEl = containerEl;
    this.inputEl = inputEl;
    this.conversations = this.sortConversations(conversations);
    this.currentConversationId = currentConversationId;
    this.callbacks = callbacks;

    this.dropdownEl = this.containerEl.createDiv({ cls: 'claudian-resume-dropdown' });
    this.render();
    this.dropdownEl.addClass('visible');

    // Dismiss on click outside the dropdown.
    this.outsideClickHandler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (this.dropdownEl.contains(target)) return;
      this.dismiss();
    };
    // Use capture phase + setTimeout so the opening click doesn't immediately
    // dismiss it.
    window.setTimeout(() => {
      activeDocument.addEventListener('mousedown', this.outsideClickHandler!, true);
    }, 0);
  }

  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.isVisible()) return false;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigate(1);
        return true;
      case 'ArrowUp':
        e.preventDefault();
        this.navigate(-1);
        return true;
      case 'Enter':
      case 'Tab':
        if (this.visibleConversations.length > 0) {
          e.preventDefault();
          this.selectItem();
          return true;
        }
        return false;
      case 'Escape':
        e.preventDefault();
        this.dismiss();
        return true;
    }
    return false;
  }

  isVisible(): boolean {
    return this.dropdownEl?.hasClass('visible') ?? false;
  }

  destroy(): void {
    if (this.outsideClickHandler) {
      activeDocument.removeEventListener('mousedown', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    this.dropdownEl?.remove();
  }

  private dismiss(): void {
    this.dropdownEl.removeClass('visible');
    this.callbacks.onDismiss();
  }

  private selectItem(): void {
    const selected = this.visibleConversations[this.selectedIndex];
    if (!selected) return;

    // Dismiss without switching if selecting the current conversation
    if (selected.id === this.currentConversationId) {
      this.dismiss();
      return;
    }

    this.callbacks.onSelect(selected.id);
  }

  private navigate(direction: number): void {
    const maxIndex = this.visibleConversations.length - 1;
    if (maxIndex < 0) return;
    this.selectedIndex = Math.max(0, Math.min(maxIndex, this.selectedIndex + direction));
    this.updateSelection();
  }

  private updateSelection(): void {
    const items = this.dropdownEl.querySelectorAll('.claudian-resume-item');
    items?.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.addClass('selected');
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.removeClass('selected');
      }
    });
  }

  private sortConversations(conversations: ConversationMeta[]): ConversationMeta[] {
    return [...conversations].sort((a, b) => {
      return (b.lastResponseAt ?? b.updatedAt ?? b.createdAt)
        - (a.lastResponseAt ?? a.updatedAt ?? a.createdAt);
    });
  }

  /** Multi-selection fork: re-fetch conversation list from caller and re-render. */
  refresh(): void {
    if (!this.callbacks.onRefresh) return;
    const updated = this.callbacks.onRefresh();
    this.conversations = this.sortConversations(updated);
    this.selectedIndex = 0;
    this.render();
    this.dropdownEl.addClass('visible');
  }

  // ============================================
  // Render
  // ============================================

  private filteredAndGrouped(): { group: string | null; items: ConversationMeta[] }[] {
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = this.conversations.filter((conv) => {
      if (!this.showArchived && isArchived(conv)) return false;
      if (!q) return true;
      return conv.title.toLowerCase().includes(q);
    });

    const byGroup = new Map<string | null, ConversationMeta[]>();
    for (const conv of filtered) {
      const gid = getGroupId(conv);
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid)!.push(conv);
    }

    // Order: named groups first (by group id ascending), then ungrouped last.
    const groupKeys = [...byGroup.keys()].filter((k): k is string => k !== null);
    groupKeys.sort();

    const result: { group: string | null; items: ConversationMeta[] }[] = [];
    for (const gid of groupKeys) {
      result.push({ group: gid, items: byGroup.get(gid)! });
    }
    if (byGroup.has(null)) {
      result.push({ group: null, items: byGroup.get(null)! });
    }
    return result;
  }

  private render(): void {
    this.dropdownEl.empty();

    this.renderHeader();
    this.renderSearchBar();
    this.renderControls();

    const sections = this.filteredAndGrouped();
    this.visibleConversations = sections.flatMap((s) => s.items);

    if (this.visibleConversations.length === 0) {
      this.dropdownEl.createDiv({
        cls: 'claudian-resume-empty',
        text: this.searchQuery ? 'No matches' : 'No conversations',
      });
      return;
    }

    if (this.selectedIndex >= this.visibleConversations.length) {
      this.selectedIndex = 0;
    }

    const list = this.dropdownEl.createDiv({ cls: 'claudian-resume-list' });

    let runningIndex = 0;
    for (const section of sections) {
      this.renderGroupHeader(list, section.group, section.items.length);
      for (const conv of section.items) {
        this.renderItem(list, conv, runningIndex);
        runningIndex++;
      }
    }
  }

  private renderHeader(): void {
    const header = this.dropdownEl.createDiv({ cls: 'claudian-resume-header' });
    header.createSpan({ cls: 'claudian-resume-header-title', text: 'Resume conversation' });

    if (this.callbacks.onRefresh) {
      const refreshBtn = header.createEl('button', {
        cls: 'claudian-resume-refresh',
        attr: { type: 'button', 'aria-label': 'Refresh sessions', title: 'Refresh sessions' },
      });
      setIcon(refreshBtn, 'refresh-cw');
      refreshBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        refreshBtn.addClass('claudian-resume-refresh--spinning');
        this.refresh();
        window.setTimeout(() => {
          refreshBtn.removeClass('claudian-resume-refresh--spinning');
        }, 400);
      });
    }
  }

  private renderSearchBar(): void {
    const wrap = this.dropdownEl.createDiv({ cls: 'claudian-resume-search' });
    const iconEl = wrap.createDiv({ cls: 'claudian-resume-search-icon' });
    setIcon(iconEl, 'search');

    const input = wrap.createEl('input', {
      cls: 'claudian-resume-search-input',
      attr: { type: 'text', placeholder: 'Search chats…', spellcheck: 'false' },
    });
    input.value = this.searchQuery;

    input.addEventListener('input', () => {
      this.searchQuery = input.value;
      this.selectedIndex = 0;
      this.rerenderListOnly();
    });
    input.addEventListener('keydown', (e) => {
      // Forward navigation keys to our handler so ArrowUp/Down/Enter works
      // even while focus is in the search field.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape') {
        this.handleKeydown(e);
      }
    });

    // Auto-focus on initial open so the user can type immediately.
    window.setTimeout(() => input.focus(), 0);
  }

  private renderControls(): void {
    const archivedCount = this.conversations.filter(isArchived).length;
    if (archivedCount === 0) return;

    const wrap = this.dropdownEl.createDiv({ cls: 'claudian-resume-controls' });
    const toggle = wrap.createEl('label', { cls: 'claudian-resume-toggle' });
    const cb = toggle.createEl('input', { attr: { type: 'checkbox' } });
    cb.checked = this.showArchived;
    toggle.createSpan({ text: `Show archived (${archivedCount})` });
    cb.addEventListener('change', () => {
      this.showArchived = cb.checked;
      this.selectedIndex = 0;
      this.rerenderListOnly();
    });
  }

  private rerenderListOnly(): void {
    // Remove existing list + empty placeholder, re-render in place. Keeps
    // search input focused (we don't recreate it).
    this.dropdownEl.querySelector('.claudian-resume-list')?.remove();
    this.dropdownEl.querySelector('.claudian-resume-empty')?.remove();

    const sections = this.filteredAndGrouped();
    this.visibleConversations = sections.flatMap((s) => s.items);

    if (this.visibleConversations.length === 0) {
      this.dropdownEl.createDiv({
        cls: 'claudian-resume-empty',
        text: this.searchQuery ? 'No matches' : 'No conversations',
      });
      return;
    }

    if (this.selectedIndex >= this.visibleConversations.length) {
      this.selectedIndex = 0;
    }

    const list = this.dropdownEl.createDiv({ cls: 'claudian-resume-list' });
    let runningIndex = 0;
    for (const section of sections) {
      this.renderGroupHeader(list, section.group, section.items.length);
      for (const conv of section.items) {
        this.renderItem(list, conv, runningIndex);
        runningIndex++;
      }
    }
  }

  private renderGroupHeader(parent: HTMLElement, groupId: string | null, count: number): void {
    const header = parent.createDiv({ cls: 'claudian-resume-group-header' });
    const label = groupId === null
      ? 'Ungrouped'
      : `Group ${groupId.startsWith('cg-') ? groupId.slice(3, 7) : groupId.slice(0, 4)}`;
    header.createSpan({ cls: 'claudian-resume-group-header-label', text: label });
    header.createSpan({ cls: 'claudian-resume-group-header-count', text: String(count) });
  }

  private renderItem(parent: HTMLElement, conv: ConversationMeta, index: number): void {
    const isCurrent = conv.id === this.currentConversationId;

    const item = parent.createDiv({ cls: 'claudian-resume-item' });
    if (isCurrent) item.addClass('current');
    if (index === this.selectedIndex) item.addClass('selected');

    const external = isExternal(conv);
    if (external) item.addClass('claudian-resume-item--external');
    if (isArchived(conv)) item.addClass('claudian-resume-item--archived');

    const iconEl = item.createDiv({ cls: 'claudian-resume-item-icon' });
    setIcon(iconEl, isCurrent ? 'message-square-dot' : external ? 'terminal' : 'message-square');

    const content = item.createDiv({ cls: 'claudian-resume-item-content' });
    const titleRow = content.createDiv({ cls: 'claudian-resume-item-title-row' });
    const titleEl = titleRow.createSpan({ cls: 'claudian-resume-item-title', text: conv.title });
    titleEl.setAttribute('title', conv.title);
    if (isArchived(conv)) {
      titleRow.createSpan({ cls: 'claudian-resume-item-badge claudian-resume-item-badge--archived', text: 'ARCH' });
    }
    if (external) {
      const badge = titleRow.createSpan({ cls: 'claudian-resume-item-badge', text: 'CLI' });
      badge.title = `External session from ${(conv as ExternalConversationMeta).sourcePath}`;
    }
    content.createDiv({
      cls: 'claudian-resume-item-date',
      text: isCurrent ? 'Current session' : this.formatDate(conv.lastResponseAt ?? conv.updatedAt ?? conv.createdAt),
    });

    item.addEventListener('click', () => {
      if (isCurrent) {
        this.dismiss();
        return;
      }
      this.callbacks.onSelect(conv.id);
    });

    item.addEventListener('mouseenter', () => {
      this.selectedIndex = index;
      this.updateSelection();
    });
  }

  private formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
}
