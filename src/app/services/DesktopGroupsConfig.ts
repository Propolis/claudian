/**
 * Claudian Multi-Selection Fork - Desktop custom groups config
 *
 * Claude Desktop stores its sidebar group state in
 *   ~/Library/Application Support/Claude/claude_desktop_config.json
 *     → preferences.epitaxyPrefs.dframe-local-slice
 *
 * Three relevant maps:
 *   - customGroupAssignments: { "code:local_<sid>": "cg-<uuid>", ... }
 *       chat → group membership
 *   - customGroupOrder:       { "cg-<uuid>": ["code:local_<sid>", ...] }
 *       intra-group session ordering + implicit group ordering (insertion)
 *   - pinnedOrder:            array of pinned chat ids
 *
 * Group NAMES (VPN, k8s, фуди, ...) are NOT stored locally — they live on
 * Claude's backend, surfaced only after the user signs into claude.ai in
 * Desktop. The user can rename groups in our settings to recover them
 * locally.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_PATH_MAC = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json',
);

export interface DesktopGroupsConfig {
  /** Maps localSessionId (without the "local_" prefix? actually WITH — see below) to its group uuid. */
  groupOfSession: Map<string, string>;
  /** Group uuid → ordered list of session ids inside it. */
  orderInGroup: Map<string, string[]>;
  /** Group uuids in the order Desktop renders them. */
  groupOrder: string[];
}

const EMPTY: DesktopGroupsConfig = {
  groupOfSession: new Map(),
  orderInGroup: new Map(),
  groupOrder: [],
};

/**
 * The assignment keys look like `code:local_<uuid>`. We strip the `code:`
 * prefix and store the full `local_<uuid>` so callers can look up by either
 * the file basename (which IS `local_<uuid>.json` → basename without ext is
 * `local_<uuid>`) or the `sessionId` field inside the file (also `local_<uuid>`).
 */
function stripCodePrefix(key: string): string {
  return key.startsWith('code:') ? key.slice('code:'.length) : key;
}

export function loadDesktopGroupsConfig(): DesktopGroupsConfig {
  if (process.platform !== 'darwin') return EMPTY;

  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH_MAC, 'utf8');
  } catch {
    return EMPTY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }

  const dframe = (((parsed as Record<string, unknown>)?.preferences as Record<string, unknown> | undefined)
    ?.epitaxyPrefs as Record<string, unknown> | undefined)
    ?.['dframe-local-slice'] as Record<string, unknown> | undefined;

  if (!dframe) return EMPTY;

  const groupOfSession = new Map<string, string>();
  const assignments = dframe.customGroupAssignments;
  if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
    for (const [k, v] of Object.entries(assignments)) {
      if (typeof v !== 'string') continue;
      groupOfSession.set(stripCodePrefix(k), v);
    }
  }

  const orderInGroup = new Map<string, string[]>();
  const groupOrder: string[] = [];
  const order = dframe.customGroupOrder;
  if (order && typeof order === 'object' && !Array.isArray(order)) {
    for (const [gid, ids] of Object.entries(order)) {
      if (!Array.isArray(ids)) continue;
      const sessionIds = ids
        .filter((x): x is string => typeof x === 'string')
        .map(stripCodePrefix);
      orderInGroup.set(gid, sessionIds);
      groupOrder.push(gid);
    }
  }

  return { groupOfSession, orderInGroup, groupOrder };
}
