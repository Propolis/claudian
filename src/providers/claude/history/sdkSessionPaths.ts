import { existsSync, readdirSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import type { SDKNativeMessage, SDKSessionReadResult } from './sdkHistoryTypes';

/**
 * Encodes a vault path for the SDK project directory name.
 * The SDK replaces ALL non-alphanumeric characters with `-`.
 * This handles Unicode characters and special chars.
 */
export function encodeVaultPathForSDK(vaultPath: string): string {
  const absolutePath = path.resolve(vaultPath);
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getSDKProjectsPath(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Validates an identifier for safe use in filesystem paths (no traversal, bounded length). */
export function isPathSafeId(value: string): boolean {
  if (!value || value.length === 0 || value.length > 128) {
    return false;
  }
  if (value.includes('..') || value.includes('/') || value.includes('\\')) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

export function isValidSessionId(sessionId: string): boolean {
  return isPathSafeId(sessionId);
}

export function getSDKSessionPath(vaultPath: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }

  const projectsPath = getSDKProjectsPath();
  const encodedVault = encodeVaultPathForSDK(vaultPath);
  return path.join(projectsPath, encodedVault, `${sessionId}.jsonl`);
}

/**
 * Multi-selection fork: locate `<sessionId>.jsonl` anywhere under
 * `~/.claude/projects/`. The vault-based path only finds chats started from
 * the vault's cwd; sessions opened in worktrees, sibling projects, or via
 * external CLI live under a different `<hash>/` and would otherwise be
 * invisible to hydration. Returns the first match, or null when truly absent.
 */
export function findSDKSessionPathAnywhere(sessionId: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  const projectsPath = getSDKProjectsPath();
  let folders: string[];
  try {
    folders = readdirSync(projectsPath);
  } catch {
    return null;
  }
  const filename = `${sessionId}.jsonl`;
  for (const folder of folders) {
    const candidate = path.join(projectsPath, folder, filename);
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* skip unreadable */ }
  }
  return null;
}

/** Resolves the on-disk JSONL path: vault-derived first, then global lookup. */
function resolveSDKSessionPath(vaultPath: string, sessionId: string): string | null {
  try {
    const vaultBased = getSDKSessionPath(vaultPath, sessionId);
    if (existsSync(vaultBased)) return vaultBased;
  } catch { /* invalid id or path — fall through to global */ }
  return findSDKSessionPathAnywhere(sessionId);
}

export function sdkSessionExists(vaultPath: string, sessionId: string): boolean {
  return resolveSDKSessionPath(vaultPath, sessionId) !== null;
}

export async function deleteSDKSession(vaultPath: string, sessionId: string): Promise<void> {
  try {
    const sessionPath = resolveSDKSessionPath(vaultPath, sessionId);
    if (!sessionPath) return;
    await fs.unlink(sessionPath);
  } catch {
    // Best-effort deletion
  }
}

export async function readSDKSession(
  vaultPath: string,
  sessionId: string,
): Promise<SDKSessionReadResult> {
  try {
    const sessionPath = resolveSDKSessionPath(vaultPath, sessionId);
    if (!sessionPath) {
      return { messages: [], skippedLines: 0 };
    }

    const content = await fs.readFile(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages: SDKNativeMessage[] = [];
    let skippedLines = 0;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as SDKNativeMessage;
        messages.push(msg);
      } catch {
        skippedLines++;
      }
    }

    return { messages, skippedLines };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { messages: [], skippedLines: 0, error: errorMsg };
  }
}
