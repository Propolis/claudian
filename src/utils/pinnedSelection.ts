/**
 * Claudian Multi-Selection Fork - Pinned Selections
 *
 * User-curated array of editor selections accumulated across multiple
 * "Attach to chat" clicks. Each entry carries a vault-relative path,
 * a 1-indexed line range, an optional Markdown heading for human-readable
 * context, the verbatim selected text, and an optional per-chip comment.
 *
 * Emitted in prompts as numbered <editor_selection> blocks so Claude can
 * cross-reference them from the main user message (e.g. "rewrite [1],
 * compare with [2]") and re-fetch via Read(offset=start-1, limit=N).
 */

export interface PinnedSelection {
  /** Stable id assigned when the selection is pinned. Surfaced to Claude as the `id` attribute. */
  id: string;
  notePath: string;
  /** 1-indexed inclusive line range. */
  startLine: number;
  endLine: number;
  /** Heading containing the selection (from Obsidian metadata cache). Empty when none above. */
  heading: string;
  /** Verbatim selected text. */
  selectedText: string;
  /** Optional per-chip user comment. */
  comment: string;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatOne(selection: PinnedSelection): string {
  const headingAttr = selection.heading
    ? ` heading="${escapeXmlAttr(selection.heading)}"`
    : '';
  const linesAttr = ` lines="${selection.startLine}-${selection.endLine}"`;
  const pathAttr = ` path="${escapeXmlAttr(selection.notePath)}"`;
  const idAttr = ` id="${escapeXmlAttr(selection.id)}"`;

  const commentBlock = selection.comment.trim()
    ? `  <user_comment>${selection.comment.trim()}</user_comment>\n`
    : '';

  return [
    `<editor_selection${idAttr}${pathAttr}${linesAttr}${headingAttr}>`,
    commentBlock + `  <content>\n${selection.selectedText}\n  </content>`,
    `</editor_selection>`,
  ].join('\n');
}

export function formatPinnedSelections(selections: PinnedSelection[]): string {
  return selections.map(formatOne).join('\n\n');
}

export function appendPinnedSelections(prompt: string, selections: PinnedSelection[]): string {
  if (!selections.length) return prompt;
  return `${prompt}\n\n${formatPinnedSelections(selections)}`;
}

export function createPinnedSelectionId(): string {
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** First N chars of selectedText, trimmed and on a single line, with ellipsis if truncated. */
export function makeSnippet(text: string, maxLen: number = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1).trimEnd() + '…';
}
