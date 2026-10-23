const queues = new Map<string, Promise<void>>();
const seen = new Map<string, { at: number; promise: Promise<void> }>();

// Serialize each private chat through presentation, not only its database write.
// Cart revisions and durable staff/session claims remain the cross-process fence.
export function serialUpdate(bot: 'customer' | 'staff', chatId: number, eventId: number | undefined, handle: () => Promise<void>): Promise<void> {
  const key = bot + ':' + chatId, event = key + ':' + eventId;
  const previous = eventId === undefined ? undefined : seen.get(event);
  if (previous && Date.now() - previous.at < 5 * 60_000) return previous.promise;
  const promise = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(handle);
  queues.set(key, promise);
  if (eventId !== undefined) seen.set(event, { at: Date.now(), promise });
  for (const [id, entry] of seen) {
    if (seen.size <= 2000 && Date.now() - entry.at < 5 * 60_000) break;
    seen.delete(id);
  }
  void promise.catch(() => { seen.delete(event); }).finally(() => {
    if (queues.get(key) === promise) queues.delete(key);
  });
  return promise;
}
