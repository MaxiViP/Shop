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
  const ids = new Set(current.map((entry) => entry.id));
  const added = incoming.filter((entry) => {
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    return true;
  });
  return added.length
    ? [...current, ...added].sort((a, b) => a.id - b.id)
    : current;
}
