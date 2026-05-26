/**
 * Claudian Multi-Selection Fork - Desktop session metadata index
 *
 * Reads Claude Desktop's per-session metadata files stored at:
 *
 *   ~/Library/Application Support/Claude/claude-code-sessions/<userId>/<orgId>/local_*.json
 *
 * Each file holds the authoritative Desktop view of a chat:
 *   - title (matches what the user sees in Desktop's chat list)
 *   - titleSource: 'user' | 'auto' | null
 *   - chromeTabGroupId: number | null  (group membership; group NAMES are
 *     held in Chromium session state and are not parseable from disk)
 *   - isArchived: boolean              (Desktop's "deleted" state)
 *   - cliSessionId: maps back to ~/.claude/projects/<...>/<cliSessionId>.jsonl
 *
 * This index supersedes JSONL-derived titles when present, giving Claudian
 * the EXACT chat names + groups + archive state that Desktop shows.
 *
 * Linux/Windows paths are different — only macOS is supported here. Other
 * platforms get an empty index, falling back to JSONL discovery.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadDesktopGroupsConfig } from './DesktopGroupsConfig';

const DESKTOP_SESSIONS_ROOT_MAC = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude-code-sessions',
);

export interface DesktopSessionMeta {
  /** cliSessionId — matches the JSONL filename in ~/.claude/projects. */
  cliSessionId: string;
  /** Desktop's local session id (`local_<uuid>`) — the file basename. */
  localSessionId: string;
  /** Desktop's displayed title for this chat. */
  title: string;
  /** 'user' (renamed manually), 'auto' (AI-generated), or null. */
  titleSource: string | null;
  /** Sidebar group uuid (cg-...) from claude_desktop_config.json. Null = Ungrouped. */
  groupId: string | null;
  /** Desktop's archive (soft-delete) flag. */
  isArchived: boolean;
  /** Working directory the session was started in. */
  cwd: string | null;
  /** Last activity timestamp (ms). */
  lastActivityAt: number | null;
}

function getDesktopSessionsRoot(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    if (fs.statSync(DESKTOP_SESSIONS_ROOT_MAC).isDirectory()) {
      return DESKTOP_SESSIONS_ROOT_MAC;
    }
  } catch { /* missing */ }
  return null;
}

/**
 * Walks the claude-code-sessions tree two levels deep (`<userId>/<orgId>/`)
 * and reads every `local_*.json` it finds. Returns a Map keyed by
 * `cliSessionId` for O(1) lookups during discovery.
 *
 * Errors on individual files are swallowed — a corrupt file shouldn't
 * break the whole index.
 */
export interface DesktopSessionsIndexResult {
  /** Keyed by cliSessionId — same as the JSONL filename. */
  byCliSessionId: Map<string, DesktopSessionMeta>;
  /** Sidebar group uuids in the order Desktop displays them. */
  groupOrder: string[];
}

export function loadDesktopSessionsIndex(): DesktopSessionsIndexResult {
  const byCliSessionId = new Map<string, DesktopSessionMeta>();
  const groupsConfig = loadDesktopGroupsConfig();
  const root = getDesktopSessionsRoot();
  if (!root) {
    return { byCliSessionId, groupOrder: groupsConfig.groupOrder };
  }

  let userDirs: string[];
  try {
    userDirs = fs.readdirSync(root);
  } catch {
    return { byCliSessionId, groupOrder: groupsConfig.groupOrder };
  }

  for (const userId of userDirs) {
    const userPath = path.join(root, userId);
    let orgDirs: string[];
    try {
      orgDirs = fs.readdirSync(userPath);
    } catch { continue; }

    for (const orgId of orgDirs) {
      const orgPath = path.join(userPath, orgId);
      let entries: string[];
      try {
        entries = fs.readdirSync(orgPath);
      } catch { continue; }

      for (const name of entries) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const filePath = path.join(orgPath, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch { continue; }
        if (!stat.isFile()) continue;

        const meta = readDesktopMetaFile(filePath, groupsConfig.groupOfSession);
        if (meta && meta.cliSessionId) {
          byCliSessionId.set(meta.cliSessionId, meta);
        }
      }
    }
  }

  return { byCliSessionId, groupOrder: groupsConfig.groupOrder };
}

function readDesktopMetaFile(
  filePath: string,
  groupOfSession: Map<string, string>,
): DesktopSessionMeta | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const cliSessionId = typeof obj.cliSessionId === 'string' ? obj.cliSessionId : null;
  if (!cliSessionId) return null;

  const localSessionId = typeof obj.sessionId === 'string' ? obj.sessionId : '';
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const titleSource = typeof obj.titleSource === 'string' ? obj.titleSource : null;
  const groupId = groupOfSession.get(localSessionId) ?? null;
  const isArchived = obj.isArchived === true;
  const cwd = typeof obj.cwd === 'string' ? obj.cwd : null;
  const lastActivityAt = typeof obj.lastActivityAt === 'number' ? obj.lastActivityAt : null;

  return {
    cliSessionId,
    localSessionId,
    title,
    titleSource,
    groupId,
    isArchived,
    cwd,
    lastActivityAt,
  };
}
