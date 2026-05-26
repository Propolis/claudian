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

const TITLE_MAX_LEN = 60;
const SESSION_FILE_EXT = '.jsonl';

interface DiscoveryOptions {
  app: App;
  /** Auto-include the vault's own CLI-projects folder. */
  includeVaultCliSessions: boolean;
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
 */
function resolveScanPaths(opts: DiscoveryOptions): string[] {
  const out: string[] = [];

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
function extractTitleFromJsonl(filePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
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

  const chosen = customTitle || aiTitle || firstUserMessage;
  if (!chosen) return '';

  const flat = chosen.replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_MAX_LEN) return flat;
  return flat.slice(0, TITLE_MAX_LEN - 1).trimEnd() + '…';
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
}

export function discoverExternalSessions(opts: DiscoveryOptions): ExternalConversationMeta[] {
  const dirs = resolveScanPaths(opts);
  if (dirs.length === 0) return [];

  const out: ExternalConversationMeta[] = [];

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
      const rawTitle = extractTitleFromJsonl(filePath);
      const cleanedTitle = stripXmlContextFromTitle(rawTitle);
      const title = cleanedTitle || `External session ${sessionId.slice(0, 8)}`;

      out.push({
        id: sessionId,
        providerId: DEFAULT_CHAT_PROVIDER_ID,
        title,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: stat.mtimeMs,
        messageCount: 0, // Unknown without full parse; the UI may show "—".
        preview: '',
        external: true,
        sourcePath: dir,
      });
    }
  }

  // Newest first.
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Same hash function as Claude Code CLI — exported for the settings UI to suggest paths. */
export { pathToProjectHash };
