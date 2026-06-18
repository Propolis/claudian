/**
 * Claudian Multi-Selection Fork — Desktop Group Names Reader (pure JS)
 *
 * Reads sidebar group names ("VPN", "фуди", …) directly from Claude Desktop's
 * Chromium localStorage, which lives in a LevelDB at
 *   ~/Library/Application Support/Claude/Local Storage/leveldb/
 *
 * The group data is the `dframe-store` localStorage entry, keyed (in Chromium's
 * localStorage encoding) under the binary key:
 *   "_https://claude.ai" + 0x00 0x01 + "dframe-store"
 * Its value is a 1-byte type tag + a JSON body:
 *   tag 0x00 → UTF-16 LE body
 *   tag 0x01 → Latin-1 body
 *   { "state": { "customGroups": [ { "id": "cg-<uuid>", "name": "<name>" }, … ] } }
 *
 * IMPLEMENTATION NOTE — why pure JS:
 *   An earlier version used the native `classic-level` binding. Native modules
 *   are fragile inside Obsidian's Electron renderer (ABI mismatch, require-path
 *   resolution) and it silently failed to load — group names never appeared.
 *   This version parses the on-disk LevelDB format directly in pure JS:
 *     - SST (.ldb) files: footer → index block → data blocks → snappy-decompress
 *       → block KV decode → match our key by LevelDB internal-key, keep the
 *       entry with the highest sequence number.
 *     - WAL (.log) file: log-record framing → write-batch decode → match key.
 *   Snappy decompression uses `snappyjs` (pure JS, bundled into main.js).
 *
 *   We read the .ldb/.log bytes directly (read-only) — no LevelDB lock needed,
 *   no temp-dir snapshot. SST files are immutable once written; a torn read of
 *   the actively-written WAL is caught per-file and skipped, falling back to the
 *   SST value.
 *
 * All failures are non-fatal — the caller gets an empty Map and the UI falls
 * back to the manual rename in Settings / the "Group <hash>" placeholder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// snappyjs is pure JS (no native binding) so esbuild bundles it into main.js.
import * as snappy from 'snappyjs';

const LEVELDB_DIR_MAC = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'Local Storage',
  'leveldb',
);

// User key for the dframe-store localStorage entry.
const TARGET_KEY = Buffer.concat([
  Buffer.from('_https://claude.ai', 'utf8'),
  Buffer.from([0x00, 0x01]),
  Buffer.from('dframe-store', 'utf8'),
]);

// LevelDB SST footer magic (little-endian of 0xdb4775248b80fb57).
const SST_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);

interface BlockHandle { offset: number; size: number }
interface KV { key: Buffer; value: Buffer }

interface CustomGroup { id?: unknown; name?: unknown }
interface DframeStore { state?: { customGroups?: CustomGroup[] } }

/** LE base-128 varint. Returns [value, nextOffset]. */
function readVarint(buf: Buffer, off: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = off;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  }
  return [result >>> 0, pos];
}

function readBlockHandle(buf: Buffer, off: number): [BlockHandle, number] {
  let offset: number;
  let size: number;
  let p = off;
  [offset, p] = readVarint(buf, p);
  [size, p] = readVarint(buf, p);
  return [{ offset, size }, p];
}

/** Read + decompress a block by handle. Skips the 4-byte CRC trailer. */
function readBlock(file: Buffer, handle: BlockHandle): Buffer {
  const start = handle.offset;
  const end = start + handle.size;
  if (start < 0 || end > file.length) throw new Error('block out of bounds');
  const data = file.subarray(start, end);
  const type = file[end]; // 1 byte compression type
  if (type === 0) return Buffer.from(data);
  if (type === 1) return Buffer.from(snappy.uncompress(data) as Uint8Array);
  throw new Error('unsupported block compression type ' + type);
}

/** Decode a LevelDB data/index block into KV entries (prefix-compressed). */
function parseBlock(block: Buffer): KV[] {
  const n = block.length;
  if (n < 4) return [];
  const restartCount = block.readUInt32LE(n - 4);
  const restartsStart = n - 4 - restartCount * 4;
  if (restartsStart < 0) return [];
  const entries: KV[] = [];
  let p = 0;
  let lastKey = Buffer.alloc(0);
  while (p < restartsStart) {
    let shared: number;
    let nonShared: number;
    let valLen: number;
    [shared, p] = readVarint(block, p);
    [nonShared, p] = readVarint(block, p);
    [valLen, p] = readVarint(block, p);
    if (p + nonShared + valLen > block.length) break;
    const keyDelta = block.subarray(p, p + nonShared);
    p += nonShared;
    const value = block.subarray(p, p + valLen);
    p += valLen;
    const key = Buffer.concat([lastKey.subarray(0, shared), keyDelta]);
    lastKey = key;
    entries.push({ key, value });
  }
  return entries;
}

/** Parse SST footer (last 48 bytes) → index handle. */
function parseFooter(file: Buffer): BlockHandle {
  if (file.length < 48) throw new Error('file too small for footer');
  const footer = file.subarray(file.length - 48);
  if (!footer.subarray(40).equals(SST_MAGIC)) throw new Error('bad SST magic');
  let p = 0;
  let metaHandle: BlockHandle;
  let indexHandle: BlockHandle;
  [metaHandle, p] = readBlockHandle(footer, p);
  void metaHandle;
  [indexHandle, p] = readBlockHandle(footer, p);
  return indexHandle;
}

/** Read all data-block KV entries from an SST file. */
function readSST(file: Buffer): KV[] {
  const indexHandle = parseFooter(file);
  const indexEntries = parseBlock(readBlock(file, indexHandle));
  const out: KV[] = [];
  for (const ie of indexEntries) {
    let handle: BlockHandle;
    try { [handle] = readBlockHandle(ie.value, 0); } catch { continue; }
    let dataBlock: Buffer;
    try { dataBlock = readBlock(file, handle); } catch { continue; }
    let entries: KV[];
    try { entries = parseBlock(dataBlock); } catch { continue; }
    for (const e of entries) out.push(e);
  }
  return out;
}

/** LevelDB internal key = userKey + 8-byte (seq<<8 | type) tag. */
function splitInternalKey(internalKey: Buffer): { userKey: Buffer; seq: number; type: number } | null {
  if (internalKey.length < 8) return null;
  const userKey = internalKey.subarray(0, internalKey.length - 8);
  const tag = internalKey.subarray(internalKey.length - 8);
  const type = tag[0];
  let seq = 0;
  for (let i = 7; i >= 1; i--) seq = seq * 256 + tag[i];
  return { userKey, seq, type };
}

interface WALRecord { key: Buffer; value: Buffer | null; type: number; seq: number }

/** Parse a LevelDB WAL (.log) file into write-batch records. */
function readWAL(file: Buffer): WALRecord[] {
  const BLOCK = 32768;
  const batches: Buffer[] = [];
  let pending: Buffer | null = null;
  let pos = 0;
  while (pos + 7 <= file.length) {
    const blockOffset = pos % BLOCK;
    if (BLOCK - blockOffset < 7) { pos += BLOCK - blockOffset; continue; }
    const len = file.readUInt16LE(pos + 4);
    const type = file[pos + 6];
    const dataStart = pos + 7;
    if (dataStart + len > file.length) break; // torn final record
    const frag = file.subarray(dataStart, dataStart + len);
    pos = dataStart + len;
    if (type === 0) continue;                                   // ZERO/padding
    else if (type === 1) batches.push(Buffer.from(frag));       // FULL
    else if (type === 2) pending = Buffer.from(frag);           // FIRST
    else if (type === 3) { if (pending) pending = Buffer.concat([pending, frag]); } // MIDDLE
    else if (type === 4) { if (pending) { batches.push(Buffer.concat([pending, frag])); pending = null; } } // LAST
  }

  const out: WALRecord[] = [];
  for (const batch of batches) {
    if (batch.length < 12) continue;
    let seq = 0;
    for (let i = 7; i >= 0; i--) seq = seq * 256 + batch[i];
    const count = batch.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count && p < batch.length; i++) {
      const recType = batch[p++]; // 0=delete, 1=put
      let klen: number;
      [klen, p] = readVarint(batch, p);
      const key = Buffer.from(batch.subarray(p, p + klen));
      p += klen;
      let value: Buffer | null = null;
      if (recType === 1) {
        let vlen: number;
        [vlen, p] = readVarint(batch, p);
        value = Buffer.from(batch.subarray(p, p + vlen));
        p += vlen;
      }
      out.push({ key, value, type: recType, seq: seq + i });
    }
  }
  return out;
}

/** Decode the localStorage value tag byte → JSON text. */
function decodeValue(raw: Buffer): string | null {
  if (!raw || raw.length < 1) return null;
  const tag = raw[0];
  const body = raw.subarray(1);
  if (tag === 0x00) return body.toString('utf16le');
  if (tag === 0x01) return body.toString('latin1');
  return null;
}

/**
 * Scan the leveldb directory, reconstruct the newest `dframe-store` value, and
 * extract its customGroups into a Map<cgUuid, name>. Empty Map on any failure.
 */
export async function readDesktopGroupNames(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (process.platform !== 'darwin') return result;
  if (!fs.existsSync(LEVELDB_DIR_MAC)) return result;

  let files: string[];
  try { files = fs.readdirSync(LEVELDB_DIR_MAC); } catch { return result; }

  let best: { seq: number; value: Buffer | null } | null = null;

  for (const f of files) {
    const full = path.join(LEVELDB_DIR_MAC, f);
    let buf: Buffer;
    try { buf = fs.readFileSync(full); } catch { continue; }

    if (f.endsWith('.ldb')) {
      let entries: KV[];
      try { entries = readSST(buf); } catch { continue; }
      for (const e of entries) {
        const sk = splitInternalKey(e.key);
        if (!sk || !sk.userKey.equals(TARGET_KEY)) continue;
        if (best === null || sk.seq > best.seq) {
          best = { seq: sk.seq, value: sk.type === 1 ? e.value : null };
        }
      }
    } else if (f.endsWith('.log')) {
      let recs: WALRecord[];
      try { recs = readWAL(buf); } catch { continue; }
      for (const r of recs) {
        if (!r.key.equals(TARGET_KEY)) continue;
        if (best === null || r.seq > best.seq) {
          best = { seq: r.seq, value: r.type === 1 ? r.value : null };
        }
      }
    }
  }

  if (!best || !best.value) return result;

  let parsed: DframeStore;
  try {
    const text = decodeValue(best.value);
    if (!text) return result;
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
  return result;
}
