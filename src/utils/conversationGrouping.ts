/**
 * Claudian Multi-Selection Fork - Conversation grouping helper
 *
 * Computes the ordered list of group sections used by both the history
 * dropdown and the /resume popup. Encapsulates:
 *   - Filtering by search query and archived state
 *   - Grouping by Desktop sidebar group uuid (cg-<uuid>) — sourced from
 *     claude_desktop_config.json → customGroupAssignments
 *   - Ordering: pinned (user) → user-defined order → Desktop's customGroupOrder
 *     → ungrouped last
 *   - Resolving display names (user-set, else "Group abcd")
 *   - Collapse state (passed through, applied by the renderer)
 */

import type { ExternalConversationMeta } from '../app/services/ExternalSessionsDiscovery';
import type { ConversationMeta } from '../core/types';

export interface GroupSection {
  /** Group uuid (cg-...), or null for the "Ungrouped" bucket. */
  groupId: string | null;
  /** Resolved display name. */
  name: string;
  /** Whether this section is currently pinned. */
  pinned: boolean;
  /** Whether this section is currently collapsed. */
  collapsed: boolean;
  items: ConversationMeta[];
}

export interface GroupSettings {
  pinnedGroupIds?: string[];
  groupOrder?: string[];
  groupNames?: Record<string, string>;
  collapsedGroupIds?: string[];
}

function isExternal(meta: ConversationMeta): meta is ExternalConversationMeta {
  return (meta as { external?: boolean }).external === true;
}

export function getGroupId(meta: ConversationMeta): string | null {
  if (!isExternal(meta)) return null;
  return meta.groupId ?? null;
}

export function isArchived(meta: ConversationMeta): boolean {
  if (!isExternal(meta)) return false;
  return meta.isArchived === true;
}

export function resolveGroupName(groupId: string | null, settings: GroupSettings): string {
  if (groupId === null) return 'Ungrouped';
  const custom = settings.groupNames?.[groupId];
  if (custom && custom.trim()) return custom.trim();
  // Fallback: short hash from the cg-<uuid>. Stable across reloads.
  const suffix = groupId.startsWith('cg-') ? groupId.slice(3, 7) : groupId.slice(0, 4);
  return `Group ${suffix}`;
}

/**
 * Computes filtered, sorted, grouped sections from a raw conversation list.
 *
 * Section ordering rules:
 *   1. Pinned groups (user-set) in `pinnedGroupIds` order.
 *   2. Then non-pinned groups, ordered by `groupOrder` (user-set), then by
 *      Desktop's `customGroupOrder` (`desktopGroupOrder`), then by id ascending
 *      for any group not in either list.
 *   3. Ungrouped bucket always last.
 *
 * `desktopGroupOrder` is the order Desktop renders groups in the sidebar.
 * Pass an empty array if unavailable.
 */
export function computeGroupSections(
  conversations: ConversationMeta[],
  settings: GroupSettings,
  options: { searchQuery: string; showArchived: boolean; desktopGroupOrder?: string[] },
): GroupSection[] {
  const q = options.searchQuery.trim().toLowerCase();
  const filtered = conversations.filter((conv) => {
    if (!options.showArchived && isArchived(conv)) return false;
    if (!q) return true;
    return conv.title.toLowerCase().includes(q);
  });

  // Bucket by group id.
  const byGroup = new Map<string | null, ConversationMeta[]>();
  for (const conv of filtered) {
    const gid = getGroupId(conv);
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid)!.push(conv);
  }

  const pinned = new Set(settings.pinnedGroupIds ?? []);
  const collapsedSet = new Set(settings.collapsedGroupIds ?? []);

  // Build the user-defined order index first, then fall back to desktop order.
  const userOrder = settings.groupOrder ?? [];
  const desktopOrder = options.desktopGroupOrder ?? [];
  const orderIndex = new Map<string, number>();
  let cursor = 0;
  for (const id of userOrder) {
    if (!orderIndex.has(id)) orderIndex.set(id, cursor++);
  }
  for (const id of desktopOrder) {
    if (!orderIndex.has(id)) orderIndex.set(id, cursor++);
  }

  const pinnedSections: GroupSection[] = [];
  const namedSections: GroupSection[] = [];
  let ungrouped: GroupSection | null = null;

  for (const [gid, items] of byGroup) {
    if (gid === null) {
      ungrouped = {
        groupId: null,
        name: 'Ungrouped',
        pinned: false,
        collapsed: collapsedSet.has('__ungrouped__'),
        items,
      };
      continue;
    }
    const section: GroupSection = {
      groupId: gid,
      name: resolveGroupName(gid, settings),
      pinned: pinned.has(gid),
      collapsed: collapsedSet.has(gid),
      items,
    };
    if (pinned.has(gid)) pinnedSections.push(section);
    else namedSections.push(section);
  }

  // Pinned: order by pinnedGroupIds index.
  const pinnedIndex = new Map<string, number>();
  (settings.pinnedGroupIds ?? []).forEach((id, idx) => pinnedIndex.set(id, idx));
  pinnedSections.sort((a, b) => {
    const ai = pinnedIndex.get(a.groupId as string) ?? Number.MAX_SAFE_INTEGER;
    const bi = pinnedIndex.get(b.groupId as string) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  // Non-pinned: orderIndex (user → desktop), then by id.
  namedSections.sort((a, b) => {
    const aOrdered = orderIndex.has(a.groupId as string);
    const bOrdered = orderIndex.has(b.groupId as string);
    if (aOrdered && bOrdered) {
      return orderIndex.get(a.groupId as string)! - orderIndex.get(b.groupId as string)!;
    }
    if (aOrdered) return -1;
    if (bOrdered) return 1;
    return (a.groupId as string).localeCompare(b.groupId as string);
  });

  const result: GroupSection[] = [...pinnedSections, ...namedSections];
  if (ungrouped) result.push(ungrouped);
  return result;
}

// =========================================================================
// Mutators — pure functions over GroupSettings, return a new copy.
// Callers persist the result via plugin.saveSettings().
// =========================================================================

export function togglePinned(settings: GroupSettings, groupId: string): GroupSettings {
  const current = settings.pinnedGroupIds ?? [];
  const next = current.includes(groupId)
    ? current.filter((id) => id !== groupId)
    : [...current, groupId];
  return { ...settings, pinnedGroupIds: next };
}

export function moveGroup(settings: GroupSettings, groupId: string, direction: 'up' | 'down'): GroupSettings {
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

function shift<T>(list: T[], item: T, direction: 'up' | 'down'): T[] {
  const idx = list.indexOf(item);
  if (idx === -1) return list;
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= list.length) return list;
  const copy = [...list];
  [copy[idx], copy[target]] = [copy[target], copy[idx]];
  return copy;
}

export function renameGroup(settings: GroupSettings, groupId: string, name: string): GroupSettings {
  const map = { ...(settings.groupNames ?? {}) };
  const trimmed = name.trim();
  if (trimmed) {
    map[groupId] = trimmed;
  } else {
    delete map[groupId];
  }
  return { ...settings, groupNames: map };
}

export function toggleCollapsed(settings: GroupSettings, groupId: string | null): GroupSettings {
  const key = groupId ?? '__ungrouped__';
  const current = settings.collapsedGroupIds ?? [];
  const next = current.includes(key)
    ? current.filter((id) => id !== key)
    : [...current, key];
  return { ...settings, collapsedGroupIds: next };
}
