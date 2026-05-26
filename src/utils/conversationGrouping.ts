/**
 * Claudian Multi-Selection Fork - Conversation grouping helper
 *
 * Computes the ordered list of group sections used by both the history
 * dropdown and the /resume popup. Encapsulates:
 *   - Filtering by search query and archived state
 *   - Grouping by chromeTabGroupId
 *   - Ordering (pinned → user-defined order → id ascending → ungrouped last)
 *   - Resolving display names (user-set or fallback to "Group XXXX")
 */

import type { ExternalConversationMeta } from '../app/services/ExternalSessionsDiscovery';
import type { ConversationMeta } from '../core/types';

export interface GroupSection {
  /** Group id, or null for the "Ungrouped" bucket. */
  groupId: number | null;
  /** Resolved display name. */
  name: string;
  /** Whether this section is currently pinned. */
  pinned: boolean;
  items: ConversationMeta[];
}

export interface GroupSettings {
  pinnedGroupIds?: number[];
  groupOrder?: number[];
  groupNames?: Record<string, string>;
}

function isExternal(meta: ConversationMeta): meta is ExternalConversationMeta {
  return (meta as { external?: boolean }).external === true;
}

export function getGroupId(meta: ConversationMeta): number | null {
  if (!isExternal(meta)) return null;
  return meta.chromeTabGroupId ?? null;
}

export function isArchived(meta: ConversationMeta): boolean {
  if (!isExternal(meta)) return false;
  return meta.isArchived === true;
}

export function resolveGroupName(groupId: number | null, settings: GroupSettings): string {
  if (groupId === null) return 'Ungrouped';
  const custom = settings.groupNames?.[String(groupId)];
  if (custom && custom.trim()) return custom.trim();
  // Fallback: last 4 digits of the group id (Chromium ids are large integers).
  return `Group ${String(groupId).slice(-4)}`;
}

/**
 * Computes filtered, sorted, grouped sections from raw conversation list.
 *
 * Section ordering rules:
 *   1. Pinned groups appear first, in `pinnedGroupIds` order.
 *   2. Then non-pinned groups, ordered by `groupOrder` (groups listed first),
 *      then by id ascending for groups not in `groupOrder`.
 *   3. Ungrouped bucket always last.
 */
export function computeGroupSections(
  conversations: ConversationMeta[],
  settings: GroupSettings,
  options: { searchQuery: string; showArchived: boolean },
): GroupSection[] {
  const q = options.searchQuery.trim().toLowerCase();
  const filtered = conversations.filter((conv) => {
    if (!options.showArchived && isArchived(conv)) return false;
    if (!q) return true;
    return conv.title.toLowerCase().includes(q);
  });

  // Bucket by group id.
  const byGroup = new Map<number | null, ConversationMeta[]>();
  for (const conv of filtered) {
    const gid = getGroupId(conv);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(conv);
  }

  const pinned = new Set(settings.pinnedGroupIds ?? []);
  const orderHints = settings.groupOrder ?? [];
  const orderIndex = new Map<number, number>();
  orderHints.forEach((id, idx) => orderIndex.set(id, idx));

  const pinnedSections: GroupSection[] = [];
  const namedSections: GroupSection[] = [];
  let ungrouped: GroupSection | null = null;

  for (const [gid, items] of byGroup) {
    if (gid === null) {
      ungrouped = {
        groupId: null,
        name: 'Ungrouped',
        pinned: false,
        items,
      };
      continue;
    }
    const section: GroupSection = {
      groupId: gid,
      name: resolveGroupName(gid, settings),
      pinned: pinned.has(gid),
      items,
    };
    if (pinned.has(gid)) pinnedSections.push(section);
    else namedSections.push(section);
  }

  // Pinned: order by pinnedGroupIds index.
  const pinnedIndex = new Map<number, number>();
  (settings.pinnedGroupIds ?? []).forEach((id, idx) => pinnedIndex.set(id, idx));
  pinnedSections.sort((a, b) => {
    const ai = pinnedIndex.get(a.groupId as number) ?? Number.MAX_SAFE_INTEGER;
    const bi = pinnedIndex.get(b.groupId as number) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  // Non-pinned: groupOrder first, then by id ascending.
  namedSections.sort((a, b) => {
    const aOrdered = orderIndex.has(a.groupId as number);
    const bOrdered = orderIndex.has(b.groupId as number);
    if (aOrdered && bOrdered) {
      return (orderIndex.get(a.groupId as number)!) - (orderIndex.get(b.groupId as number)!);
    }
    if (aOrdered) return -1;
    if (bOrdered) return 1;
    return (a.groupId as number) - (b.groupId as number);
  });

  const result: GroupSection[] = [...pinnedSections, ...namedSections];
  if (ungrouped) result.push(ungrouped);
  return result;
}

// =========================================================================
// Mutators — pure functions over GroupSettings, return a new copy.
// Callers persist the result via plugin.saveSettings().
// =========================================================================

export function togglePinned(settings: GroupSettings, groupId: number): GroupSettings {
  const current = settings.pinnedGroupIds ?? [];
  const next = current.includes(groupId)
    ? current.filter((id) => id !== groupId)
    : [...current, groupId];
  return { ...settings, pinnedGroupIds: next };
}

export function moveGroup(settings: GroupSettings, groupId: number, direction: 'up' | 'down'): GroupSettings {
  // Determine which list this group lives in (pinned vs ordered).
  const pinned = settings.pinnedGroupIds ?? [];
  if (pinned.includes(groupId)) {
    return { ...settings, pinnedGroupIds: shift(pinned, groupId, direction) };
  }
  const order = [...(settings.groupOrder ?? [])];
  if (!order.includes(groupId)) {
    // Insert at end so we have something to swap against.
    order.push(groupId);
  }
  return { ...settings, groupOrder: shift(order, groupId, direction) };
}

function shift(list: number[], item: number, direction: 'up' | 'down'): number[] {
  const idx = list.indexOf(item);
  if (idx === -1) return list;
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= list.length) return list;
  const copy = [...list];
  [copy[idx], copy[target]] = [copy[target], copy[idx]];
  return copy;
}

export function renameGroup(settings: GroupSettings, groupId: number, name: string): GroupSettings {
  const map = { ...(settings.groupNames ?? {}) };
  const trimmed = name.trim();
  if (trimmed) {
    map[String(groupId)] = trimmed;
  } else {
    delete map[String(groupId)];
  }
  return { ...settings, groupNames: map };
}
