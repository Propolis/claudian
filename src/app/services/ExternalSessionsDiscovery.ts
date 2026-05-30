/**
 * Claudian Multi-Selection Fork - External CLI Session Discovery
 *
 * Scans configured `~/.claude/projects/<cwd-hash>/` folders for `*.jsonl`
 * session transcripts and synthesizes in-memory ConversationMeta entries
 * for them. Lets the resume dropdown show sessions started outside Claudian
 * (e.g. via the Claude Code CLI in a terminal) without copying data.
 *
 * Source of truth stays the JSONL file. We do NOT write any `.meta.json`
 * for these — they remain external. Their `id` is the sessionId so they
 * resume cleanly through the SDK's `--resume <sessionId>` flow.
 */

import * as fs from 'fs';
import type { App } from 'obsidian';
import * as path from 'path';

import { DEFAULT_CHAT_PROVIDER_ID } from '../../core/providers/types';
import type { ConversationMeta } from '../../core/types';
import { expandHomePath, getVaultPath } from '../../utils/path';
import { loadDesktopSessionsIndex } from './DesktopSessionsIndex';

const TITLE_MAX_LEN = 60;
const SESSION_FILE_EXT = '.jsonl';

interface DiscoveryOptions {
  app: App;
  /** Auto-include the vault's own CLI-projects folder. */
  includeVaultCliSessions: boolean;
  /**
   * When true, scan EVERY subfolder of ~/.claude/projects/ — picks up sessions
   * from all cwds, not just the vault's. Overrides the more selective options.
   */
  scanAllProjectFolders?: boolean;
  /** Additional absolute paths to scan (already validated/non-empty). */
  externalSessionPaths: string[];
}

/**
 * Mirrors Claude Code CLI's project-hash convention: collapse every run of
 * non-alphanumeric characters into a single dash. The leading `/` of an
 * absolute path becomes the leading `-`.
 *
 *   /Users/maksim/Library/Mobile Documents/iCloud~md~obsidian/Documents
 *     → -Users-maksim-Library-Mobile-Documents-iCloud-md-obsidian-Documents
 *
 * Important: must handle spaces (e.g. "Mobile Documents"), dots, tildes,
 * underscores — anything not alphanumeric. Verified against the user's
 * existing `~/.claude/projects/-Users-maksim-Library-Mobile-Documents-...-Documents`.
 */
function pathToProjectHash(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  return normalized
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-$/, '');
}

function getVaultCliProjectsDir(app: App): string | null {
  const vaultPath = getVaultPath(app);
  if (!vaultPath) return null;
  const hash = pathToProjectHash(vaultPath);
  return path.join(expandHomePath('~/.claude/projects'), hash);
}

/**
 * Returns all unique absolute paths to scan, after expansion and existence check.
 * Auto-detected vault path is first (so its sessions sort first on ties).
 *
 * When `scanAllProjectFolders` is true, every subfolder of ~/.claude/projects/
 * is included — this picks up sessions from any cwd the user has worked from.
 */
function resolveScanPaths(opts: DiscoveryOptions): string[] {
  const out: string[] = [];

  if (opts.scanAllProjectFolders) {
    const projectsRoot = expandHomePath('~/.claude/projects');
    try {
      const entries = fs.readdirSync(projectsRoot);
      for (const entry of entries) {
        const sub = path.join(projectsRoot, entry);
        try {
          if (fs.statSync(sub).isDirectory()) out.push(sub);
        } catch { /* skip unreadable */ }
      }
    } catch { /* projects dir missing — skip silently */ }
  }

  if (opts.includeVaultCliSessions) {
    const dir = getVaultCliProjectsDir(opts.app);
    if (dir) out.push(dir);
  }

  for (const raw of opts.externalSessionPaths) {
    if (!raw || !raw.trim()) continue;
    const expanded = expandHomePath(raw.trim());
    out.push(path.resolve(expanded));
  }

  // Dedupe + filter to existing directories.
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Source of a JSONL session title, in precedence order.
 * `custom` and `ai` are authoritative (CLI / Desktop wrote them); the fallback
 * `first-user` is a guess that should NOT overwrite native Claudian titles.
 */
export type JsonlTitleSource = 'custom' | 'ai' | 'first-user' | 'none';

export interface JsonlTitleResult {
  title: string;
  source: JsonlTitleSource;
}

/**
 * Extracts the chat title from a JSONL session file using the same precedence
 * as the Claude Code desktop app / CLI:
 *
 *   1. Last `{"type":"custom-title","customTitle":"…"}` entry (user-set title)
 *   2. Last `{"type":"ai-title","aiTitle":"…"}` entry (AI-generated title)
 *   3. Fallback: first user message text (stripped of XML context blocks)
 *
 * Title entries appear MULTIPLE times in the file (each regeneration appends
 * a new line). The latest one is authoritative.
 *
 * Performance note: reads the entire file once. JSONL files can be a few MB
 * but parsing line-by-line is fast (~10-50ms even for 4MB). Cheap substring
 * pre-filter skips JSON.parse for lines that aren't title entries.
 */
function extractTitleResultFromJsonl(filePath: string): JsonlTitleResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { title: '', source: 'none' };
  }

  let customTitle = '';
  let aiTitle = '';
  let firstUserMessage = '';

  const lines = content.split('\n');
  for (const line of lines) {
    if (!line || line.length < 16) continue; // skip blank / impossibly short lines

    // Cheap pre-filter: avoid JSON.parse for lines that obviously aren't titles.
    if (line.includes('"type":"custom-title"')) {
      try {
        const entry = JSON.parse(line) as { customTitle?: unknown };
        if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
          customTitle = entry.customTitle; // last occurrence wins
        }
      } catch { /* malformed line, skip */ }
      continue;
    }

    if (line.includes('"type":"ai-title"')) {
      try {
        const entry = JSON.parse(line) as { aiTitle?: unknown };
        if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
          aiTitle = entry.aiTitle; // last occurrence wins
        }
      } catch { /* malformed line, skip */ }
      continue;
    }

    // Capture first user message as last-resort fallback.
    if (!firstUserMessage && line.includes('"type":"user"')) {
      try {
        const entry = JSON.parse(line);
        const text = readUserText(entry);
        if (text) firstUserMessage = text;
      } catch { /* skip */ }
    }
  }

  let source: JsonlTitleSource;
  let chosen: string;
  if (customTitle) {
    chosen = customTitle;
    source = 'custom';
  } else if (aiTitle) {
    chosen = aiTitle;
    source = 'ai';
  } else if (firstUserMessage) {
    chosen = firstUserMessage;
    source = 'first-user';
  } else {
    return { title: '', source: 'none' };
  }

  const flat = chosen.replace(/\s+/g, ' ').trim();
  if (!flat) return { title: '', source: 'none' };
  const title = flat.length <= TITLE_MAX_LEN
    ? flat
    : flat.slice(0, TITLE_MAX_LEN - 1).trimEnd() + '…';
  return { title, source };
}

/** Back-compat wrapper for callers that only need the string. */
function extractTitleFromJsonl(filePath: string): string {
  return extractTitleResultFromJsonl(filePath).title;
}

/**
 * Defensively pulls human-readable text out of a JSONL entry's user message.
 * Handles both the legacy `{ message: { role: "user", content: "..." } }` shape
 * and the SDK's `{ message: { role: "user", content: [{type:"text", text:"..."}] } }` shape.
 */
function readUserText(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return '';
  const obj = entry as Record<string, unknown>;

  // Hierarchical: entry.message.{role, content}
  const message = obj.message;
  if (typeof message === 'object' && message !== null) {
    const m = message as Record<string, unknown>;
    if (m.role !== 'user') return '';
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const c of content) {
        if (typeof c === 'string') {
          parts.push(c);
        } else if (typeof c === 'object' && c !== null) {
          const cc = c as Record<string, unknown>;
          if (cc.type === 'text' && typeof cc.text === 'string') {
            parts.push(cc.text);
          }
        }
      }
      return parts.join(' ');
    }
  }

  // Flat: entry.role === 'user', entry.content === '...'
  if (obj.role === 'user') {
    if (typeof obj.content === 'string') return obj.content;
  }

  return '';
}

/**
 * Strips XML context blocks (e.g. <editor_selection>, <current_note>) from
 * a title so the user-visible title shows the actual question, not the
 * Claudian-appended context.
 */
function stripXmlContextFromTitle(title: string): string {
  return title
    .replace(/<editor_selection[\s\S]*?<\/editor_selection>/g, '')
    .replace(/<current_note>[\s\S]*?<\/current_note>/g, '')
    .replace(/<editor_cursor[\s\S]*?<\/editor_cursor>/g, '')
    .replace(/<context_files>[\s\S]*?<\/context_files>/g, '')
    .replace(/<browser_selection[\s\S]*?<\/browser_selection>/g, '')
    .replace(/<canvas_selection[\s\S]*?<\/canvas_selection>/g, '')
    .replace(/<user_message>([\s\S]*?)<\/user_message>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns synthesized ConversationMeta for each `.jsonl` session found in the
 * configured paths. Each entry uses the JSONL filename (minus `.jsonl`) as
 * both `id` and `sessionId`, marks itself as `external: true`, and carries
 * `sourcePath` so the UI can attribute the entry to its host folder.
 */
export interface ExternalConversationMeta extends ConversationMeta {
  external: true;
  sourcePath: string;
  /** Sidebar group uuid from Desktop (cg-...). Null = ungrouped / not tracked by Desktop. */
  groupId?: string | null;
  /** True if Desktop has archived (soft-deleted) this chat. */
  isArchived?: boolean;
  /** True when Desktop knows the session but no JSONL transcript exists on disk. */
  noTranscript?: boolean;
}

/**
 * Multi-selection fork: full JSONL session info — emitted for EVERY .jsonl
 * found across the configured paths (whether the session is also Claudian-native
 * or pure external). Lets the plugin sync native titles from JSONL and surface
 * external-only sessions in the resume dropdown in a single discovery pass.
 *
 * Title precedence (highest first):
 *   1. Desktop metadata (`claude-code-sessions/.../local_*.json` → `title`)
 *      — this is what the user sees in Claude Desktop, the canonical name.
 *   2. JSONL `custom-title` entry (manual rename via CLI)
 *   3. JSONL `ai-title` entry (SDK-generated)
 *   4. First user message (best-effort fallback)
 */
export interface JsonlSessionInfo {
  sessionId: string;
  /** Title resolved per the precedence above. */
  title: string;
  /** Where the title came from. */
  titleSource: 'desktop' | JsonlTitleSource;
  /** Sidebar group uuid from Desktop (cg-...), or null if ungrouped / not in index. */
  groupId: string | null;
  /** True if Desktop has soft-deleted (archived) this chat. */
  isArchived: boolean;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
  /**
   * True when no JSONL was found for this session — Desktop knows about it
   * but the transcript is missing (deleted or never written). Such sessions
   * can be displayed but cannot be resumed.
   */
  noTranscript?: boolean;
}

/**
 * Walks every `~/.claude/projects/<hash>/` subfolder once and returns a
 * sessionId → containing-directory map. Used by Pass 2 to find JSONLs that
 * live outside the configured scan paths (e.g. chats started in a worktree
 * or sibling project) so we don't falsely flag them `noTranscript: true`.
 *
 * Cheap: ~50 readdirSync calls, only when discovery runs (sync button / focus).
 */
function buildGlobalSessionIndex(): Map<string, string> {
  const projectsRoot = expandHomePath('~/.claude/projects');
  const out = new Map<string, string>();
  let folders: string[];
  try {
    folders = fs.readdirSync(projectsRoot);
  } catch {
    return out;
  }
  for (const folder of folders) {
    const dir = path.join(projectsRoot, folder);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(SESSION_FILE_EXT)) continue;
        const sessionId = name.slice(0, -SESSION_FILE_EXT.length);
        if (!out.has(sessionId)) out.set(sessionId, dir);
      }
    } catch { /* unreadable folder — skip */ }
  }
  return out;
}

export function discoverAllJsonlSessions(opts: DiscoveryOptions): JsonlSessionInfo[] {
  const dirs = resolveScanPaths(opts);

  // Load Desktop metadata index — primary source for groups + archived + titles.
  const desktopIndex = loadDesktopSessionsIndex().byCliSessionId;

  const out: JsonlSessionInfo[] = [];
  const seenCliSessionIds = new Set<string>();

  // Pass 1 — walk JSONL files in configured project dirs. These can be resumed.
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith(SESSION_FILE_EXT)) continue;

      const filePath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;

      const sessionId = name.slice(0, -SESSION_FILE_EXT.length);
      seenCliSessionIds.add(sessionId);
      const desktopMeta = desktopIndex.get(sessionId);

      // Desktop title wins. Fall back to JSONL parse if Desktop has nothing.
      let title: string;
      let titleSource: JsonlSessionInfo['titleSource'];
      if (desktopMeta?.title) {
        title = desktopMeta.title;
        titleSource = 'desktop';
      } else {
        const fromJsonl = extractTitleResultFromJsonl(filePath);
        title = stripXmlContextFromTitle(fromJsonl.title);
        titleSource = fromJsonl.source;
      }

      out.push({
        sessionId,
        title,
        titleSource,
        groupId: desktopMeta?.groupId ?? null,
        isArchived: desktopMeta?.isArchived ?? false,
        sourcePath: dir,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: desktopMeta?.lastActivityAt ?? stat.mtimeMs,
      });
    }
  }

  // Pass 2 — Desktop-tracked sessions Pass 1 missed. Either:
  //   (a) JSONL lives outside the configured scan dirs (different cwd /
  //       worktree) → recover it via a global lookup so the user can open it.
  //   (b) Truly no JSONL on disk (transcript deleted, or chat never wrote one)
  //       → keep the noTranscript placeholder so chat counts match Desktop.
  const globalSessionIndex = buildGlobalSessionIndex();
  for (const [cliSessionId, desktopMeta] of desktopIndex) {
    if (seenCliSessionIds.has(cliSessionId)) continue;

    const externalDir = globalSessionIndex.get(cliSessionId);
    if (externalDir) {
      const filePath = path.join(externalDir, cliSessionId + SESSION_FILE_EXT);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;

      let title: string;
      let titleSource: JsonlSessionInfo['titleSource'];
      if (desktopMeta.title) {
        title = desktopMeta.title;
        titleSource = 'desktop';
      } else {
        const fromJsonl = extractTitleResultFromJsonl(filePath);
        title = stripXmlContextFromTitle(fromJsonl.title);
        titleSource = fromJsonl.source;
      }

      seenCliSessionIds.add(cliSessionId);
      out.push({
        sessionId: cliSessionId,
        title,
        titleSource,
        groupId: desktopMeta.groupId,
        isArchived: desktopMeta.isArchived,
        sourcePath: externalDir,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: desktopMeta.lastActivityAt ?? stat.mtimeMs,
      });
      continue;
    }

    out.push({
      sessionId: cliSessionId,
      title: desktopMeta.title || `Untitled ${cliSessionId.slice(0, 8)}`,
      titleSource: 'desktop',
      groupId: desktopMeta.groupId,
      isArchived: desktopMeta.isArchived,
      sourcePath: '<desktop-only>',
      createdAt: desktopMeta.lastActivityAt ?? Date.now(),
      updatedAt: desktopMeta.lastActivityAt ?? Date.now(),
      noTranscript: true,
    });
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * Convenience wrapper: returns only entries suitable for the resume dropdown's
 * external slot. Caller should still call discoverAllJsonlSessions if it wants
 * to sync native titles.
 */
export function discoverExternalSessions(opts: DiscoveryOptions): ExternalConversationMeta[] {
  return discoverAllJsonlSessions(opts).map((info) => ({
    id: info.sessionId,
    providerId: DEFAULT_CHAT_PROVIDER_ID,
    title: info.title || `External session ${info.sessionId.slice(0, 8)}`,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    messageCount: 0,
    preview: '',
    external: true,
    sourcePath: info.sourcePath,
    groupId: info.groupId,
    isArchived: info.isArchived,
    noTranscript: info.noTranscript,
  }));
}

/** Same hash function as Claude Code CLI — exported for the settings UI to suggest paths. */
export { pathToProjectHash };
