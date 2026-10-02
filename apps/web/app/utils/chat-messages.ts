import type { ChatMessage } from "../types/coordination";

export function createChatHistory() {
  return {
    messages: [] as ChatMessage[],
    initialLoaded: false,
    cursor: undefined as number | undefined,
  };
}

export function receiveMessages(
  history: ReturnType<typeof createChatHistory>,
  incoming: ChatMessage[],
) {
  const previous = history.messages;
  history.messages = mergeMessages(previous, incoming);
  history.cursor = incoming.at(-1)?.id ?? history.cursor;
  history.initialLoaded = true;
  return history.messages !== previous;
}

// Persisted IDs also define the server's cursor order. Keep existing objects.
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map(entry => [entry.id, entry]));
  let changed = false;
  for (const entry of incoming) {
    const previous = byId.get(entry.id);
    if (!previous || (entry.imageRevision ?? 0) > (previous.imageRevision ?? 0) ||
      (entry.imageExpired && !previous.imageExpired)) {
      byId.set(entry.id, entry);
      changed = true;
    }
  }
  return changed ? [...byId.values()].sort((a, b) => a.id - b.id) : current;
}

export function applyImageRevisions(history: ReturnType<typeof createChatHistory>,
  updates: { id: number; imageRevision: number; imageExpired: boolean;
    revisionText: string | null; revisionActor: ChatMessage['revisionActor']; revisionAt: string | null }[]) {
  const byId = new Map(updates.map(update => [update.id, update]));
  let changed = false;
  const next = history.messages.map(entry => {
    const update = byId.get(entry.id);
    if (!update || ((entry.imageRevision ?? 0) >= update.imageRevision &&
      (!update.imageExpired || entry.imageExpired))) return entry;
    changed = true;
    return { ...entry, ...update };
  });
  if (changed) history.messages = next;
  return changed;
}
