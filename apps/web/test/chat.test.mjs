import test from "node:test";
import assert from "node:assert/strict";
import {
  applyImageRevisions,
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

test("photo revisions update the same visible message and never roll back after a delayed poll", () => {
  const history = createChatHistory();
  receiveMessages(history, [{ ...message(1), image: true, imageRevision: 0, imageExpired: false }]);
  const first = history.messages[0];
  assert.equal(applyImageRevisions(history, [{ id: 1, imageRevision: 1, imageExpired: false,
    revisionText: "Вот этот", revisionActor: "CUSTOMER", revisionAt: "2026-10-02T10:00:00Z" }]), true);
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, first.id);
  assert.equal(history.messages[0].revisionText, "Вот этот");
  assert.equal(history.cursor, 1);
  assert.equal(applyImageRevisions(history, [{ id: 1, imageRevision: 0, imageExpired: false,
    revisionText: null, revisionActor: null, revisionAt: null }]), false);
  assert.equal(mergeMessages(history.messages, [first]), history.messages);
  assert.equal(applyImageRevisions(history, [{ id: 1, imageRevision: 1, imageExpired: true,
    revisionText: "Вот этот", revisionActor: "CUSTOMER", revisionAt: "2026-10-02T10:00:00Z" }]), true);
  assert.equal(history.messages[0].imageExpired, true);
});

test("an unread old photo joins the feed without moving the latest-message poll cursor", () => {
  const history = createChatHistory();
  receiveMessages(history, Array.from({ length: 30 }, (_, index) => message(index + 11)));
  const oldPhoto = { ...message(1, 'SELLER'), image: true, imageRevision: 2,
    revisionText: 'Отмечено', imageExpired: false };
  history.messages = mergeMessages(history.messages, [oldPhoto]);
  assert.equal(history.cursor, 40);
  assert.deepEqual(history.messages.map((entry) => entry.id), [1, ...Array.from({ length: 30 }, (_, index) => index + 11)]);
  history.messages = mergeMessages(history.messages, [{ ...message(1), image: true, imageRevision: 0 }]);
  assert.equal(history.messages.filter((entry) => entry.id === 1).length, 1);
  assert.equal(history.messages[0].revisionText, 'Отмечено');
});
