/**
 * Claudian Multi-Selection Fork — Desktop Group Names Reader
 *
 * Reads sidebar group names ("VPN", "фуди", …) directly from Claude Desktop's
 * Chromium localStorage. This was assumed to be impossible based on an earlier
 * audit, but turned out the audit only checked UTF-8 byte patterns — Desktop
 * actually stores its Redux/zustand `dframe-store` slice as a UTF-16 LE JSON
 * blob keyed under `_https://claude.ai\x00\x01dframe-store` inside the leveldb
 * at `~/Library/Application Support/Claude/Local Storage/leveldb/`.
 *
 * Structure of the relevant value:
 *   { "state": { "customGroups": [ { "id": "cg-<uuid>", "name": "<name>" }, … ] } }
 *
 * Encoding (Chromium localStorage SerializedScriptValue v0):
 *   byte 0 == 0x00 → body is UTF-16 LE
 *   byte 0 == 0x01 → body is Latin-1 / ISO-8859-1
 *
 * Locking:
 *   Desktop holds an exclusive lock on the leveldb whenever it is running. We
 *   sidestep by copying the whole leveldb directory to a tmp dir, deleting the
 *   LOCK file, and opening the copy.
 *
 * Failures are non-fatal — Desktop not installed, leveldb format change,
 * key missing, classic-level binary mismatch — all swallowed; the caller gets
 * an empty Map and downstream rendering falls back to the existing manual
 * bulk-rename UI / "Group <hash>" placeholder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LEVELDB_DIR_MAC = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'Local Storage',
  'leveldb',
);

const LOCAL_STORAGE_KEY_PARTS = {
  prefix: Buffer.from('_https://claude.ai', 'utf8'),
  separator: Buffer.from([0x00, 0x01]),
  name: Buffer.from('dframe-store', 'utf8'),
};

interface CustomGroup {
  id?: unknown;
  name?: unknown;
}

interface DframeStore {
  state?: {
    customGroups?: CustomGroup[];
  };
}

/**
 * Snapshot the leveldb dir to a temp location, open with classic-level,
 * extract group id → name pairs from `dframe-store`. Returns empty Map on
 * any failure.
 */
export async function readDesktopGroupNames(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (process.platform !== 'darwin') return result;
  if (!fs.existsSync(LEVELDB_DIR_MAC)) return result;

  // classic-level is loaded dynamically: it has a native binding which may
  // fail to load on incompatible Electron ABIs. Catching the import error
  // lets the plugin degrade gracefully instead of crashing on startup.
  let ClassicLevel: typeof import('classic-level').ClassicLevel;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ClassicLevel = require('classic-level').ClassicLevel;
  } catch (err) {
    // Native binding mismatch with Obsidian's Electron — fall back silently.
    console.warn('[Claudian] classic-level unavailable, group names will not be auto-loaded:', err);
    return result;
  }

  // Snapshot the leveldb to bypass Desktop's exclusive LOCK.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-ldb-'));
  try {
    fs.cpSync(LEVELDB_DIR_MAC, tmpDir, { recursive: true });
    // Remove the LOCK file from the COPY so we can open it freely. The
    // original LOCK in the source is untouched and Desktop is unaffected.
    try { fs.rmSync(path.join(tmpDir, 'LOCK')); } catch { /* ignore */ }

    const db = new ClassicLevel(tmpDir, {
      keyEncoding: 'binary',
      valueEncoding: 'binary',
    });

    try {
      await db.open();
      const key = Buffer.concat([
        LOCAL_STORAGE_KEY_PARTS.prefix,
        LOCAL_STORAGE_KEY_PARTS.separator,
        LOCAL_STORAGE_KEY_PARTS.name,
      ]);

      let raw: Buffer;
      try {
        raw = (await db.get(key)) as unknown as Buffer;
      } catch {
        // Key absent (Desktop never logged into claude.ai? Brand-new install?).
        return result;
      }
      if (!raw || raw.length < 2) return result;

      const typeByte = raw[0];
      const body = raw.subarray(1);
      let text: string;
      switch (typeByte) {
        case 0x00: text = body.toString('utf16le'); break;
        case 0x01: text = body.toString('latin1'); break;
        default: return result; // Unknown SerializedScriptValue tag.
      }

      let parsed: DframeStore;
      try {
        parsed = JSON.parse(text) as DframeStore;
      } catch {
        return result;
      }

      const groups = parsed.state?.customGroups;
      if (!Array.isArray(groups)) return result;
      for (const g of groups) {
        if (typeof g?.id !== 'string') continue;
        if (typeof g?.name !== 'string') continue;
        if (!g.name.trim()) continue;
        result.set(g.id, g.name);
      }
    } finally {
      try { await db.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[Claudian] Failed to read desktop group names:', err);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return result;
}
