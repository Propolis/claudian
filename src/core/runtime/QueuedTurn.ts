import type { PinnedSelection } from '../../utils/pinnedSelection';
import type { ImageAttachment } from '../types';
import type { ChatTurnRequest } from './types';

export interface QueuedChatTurn {
  displayContent: string;
  request: ChatTurnRequest;
}

export function cloneChatTurnRequest(request: ChatTurnRequest): ChatTurnRequest {
  return {
    ...request,
    images: cloneImages(request.images),
    pinnedSelections: clonePinnedSelections(request.pinnedSelections),
    externalContextPaths: request.externalContextPaths
      ? [...request.externalContextPaths]
      : undefined,
    enabledMcpServers: request.enabledMcpServers
      ? new Set(request.enabledMcpServers)
      : undefined,
  };
}

export function cloneQueuedChatTurn(turn: QueuedChatTurn): QueuedChatTurn {
  return {
    displayContent: turn.displayContent,
    request: cloneChatTurnRequest(turn.request),
  };
}

export function mergeQueuedChatTurns(
  existing: QueuedChatTurn,
  incoming: QueuedChatTurn,
): QueuedChatTurn {
  const existingRequest = existing.request;
  const incomingRequest = incoming.request;

  return {
    displayContent: mergeText(existing.displayContent, incoming.displayContent),
    request: {
      ...cloneChatTurnRequest(incomingRequest),
      text: mergeText(existingRequest.text, incomingRequest.text),
      images: mergeImages(existingRequest.images, incomingRequest.images),
      currentNotePath: incomingRequest.currentNotePath ?? existingRequest.currentNotePath,
      pinnedSelections: mergePinnedSelections(
        existingRequest.pinnedSelections,
        incomingRequest.pinnedSelections,
      ),
      externalContextPaths: mergeStringLists(
        existingRequest.externalContextPaths,
        incomingRequest.externalContextPaths,
      ),
      enabledMcpServers: mergeSets(
        existingRequest.enabledMcpServers,
        incomingRequest.enabledMcpServers,
      ),
    },
  };
}

function mergeText(first: string, second: string): string {
  return [first, second]
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .join('\n\n');
}

function cloneImages(images: ImageAttachment[] | undefined): ImageAttachment[] | undefined {
  return images && images.length > 0 ? [...images] : undefined;
}

function clonePinnedSelections(
  selections: PinnedSelection[] | null | undefined,
): PinnedSelection[] | undefined {
  if (!selections || selections.length === 0) return undefined;
  return selections.map((s) => ({ ...s }));
}

function mergePinnedSelections(
  first: PinnedSelection[] | null | undefined,
  second: PinnedSelection[] | null | undefined,
): PinnedSelection[] | undefined {
  const merged = [...(first ?? []), ...(second ?? [])];
  if (merged.length === 0) return undefined;
  return merged.map((s) => ({ ...s }));
}

function mergeImages(
  first: ImageAttachment[] | undefined,
  second: ImageAttachment[] | undefined,
): ImageAttachment[] | undefined {
  const merged = [...(first ?? []), ...(second ?? [])];
  return merged.length > 0 ? merged : undefined;
}

function mergeStringLists(
  first: string[] | undefined,
  second: string[] | undefined,
): string[] | undefined {
  const merged = [...(first ?? []), ...(second ?? [])];
  if (merged.length === 0) {
    return undefined;
  }
  return Array.from(new Set(merged));
}

function mergeSets<T>(
  first: Set<T> | undefined,
  second: Set<T> | undefined,
): Set<T> | undefined {
  const merged = new Set<T>();
  for (const value of first ?? []) {
    merged.add(value);
  }
  for (const value of second ?? []) {
    merged.add(value);
  }
  return merged.size > 0 ? merged : undefined;
}
