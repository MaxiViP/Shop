import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatHistory,
  mergeMessages,
  receiveMessages,
} from "../app/utils/chat-messages.ts";

const message = (id, authorType = "CUSTOMER") => ({
  id,
  authorType,
  text: `Message ${id}`,
  createdAt: "2026-09-09T10:00:00Z",
});
test("initial loading ends once, even for an empty chat; background polling does not reset it", () => {
  const history = createChatHistory();
  assert.equal(history.initialLoaded, false);
  assert.deepEqual(history.messages, []);
  const initial = history.messages;
  assert.equal(receiveMessages(history, []), false);
  assert.equal(history.initialLoaded, true);
  assert.equal(receiveMessages(history, []), false);
  assert.equal(history.messages, initial);
  assert.equal(history.initialLoaded, true);
});
test("poll cursor never skips unseen messages when a POST arrives first", () => {
  const history = createChatHistory();
  receiveMessages(history, [message(1)]);
  history.messages = mergeMessages(history.messages, [message(4)]);
  assert.equal(history.cursor, 1);
  assert.equal(
    receiveMessages(history, [message(2), message(3), message(4)]),
    true,
  );
  assert.equal(history.cursor, 4);
  assert.deepEqual(
    history.messages.map((m) => m.id),
    [1, 2, 3, 4],
  );
});
test("empty background response preserves array and message identities", () => {
  const current = [message(1)];
  assert.equal(mergeMessages(current, []), current);
  assert.equal(mergeMessages(current, [message(1)]), current);
});
test("POST response appears immediately, subsequent GET is deduplicated", () => {
  const first = message(1);
  const posted = message(4);
  const current = mergeMessages([first], [posted]);
  assert.deepEqual(
    current.map((m) => m.id),
    [1, 4],
  );
  const merged = mergeMessages(current, [
    message(2, "SELLER"),
    message(3),
    message(4),
  ]);
  assert.deepEqual(
    merged.map((m) => m.id),
    [1, 2, 3, 4],
  );
  assert.equal(merged[0], first);
  assert.equal(merged[3], posted);
});
test("older pages keep chronological order and ignore duplicate incoming IDs", () => {
  assert.deepEqual(
    mergeMessages([message(3)], [message(2), message(1), message(2)]).map(
      (m) => m.id,
    ),
    [1, 2, 3],
  );
});
