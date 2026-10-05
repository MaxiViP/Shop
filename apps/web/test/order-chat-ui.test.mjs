import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cardClickNavigates,
  cardKeyNavigates,
} from "../app/utils/order-card.ts";
import {
  chatPhotoError,
  chatRequest,
  isHeicPhoto,
  prepareChatPhoto,
} from "../app/utils/chat-photo.ts";

const component = (name) =>
  readFile(new URL(`../app/${name}`, import.meta.url), "utf8");

test("staff card opens from its surface and keyboard, while inner controls keep their action", () => {
  const card = { closest: () => null };
  const action = { closest: () => ({ tagName: "BUTTON" }) };
  assert.equal(cardClickNavigates(card), true);
  assert.equal(cardClickNavigates(action), false);
  assert.equal(
    cardKeyNavigates({ target: card, currentTarget: card, key: "Enter" }),
    true,
  );
  assert.equal(
    cardKeyNavigates({ target: card, currentTarget: card, key: " " }),
    true,
  );
  assert.equal(
    cardKeyNavigates({ target: action, currentTarget: card, key: "Enter" }),
    false,
  );
  assert.equal(
    cardKeyNavigates({ target: card, currentTarget: card, key: "Escape" }),
    false,
  );
});

test("text-only, image-only, and text with image use the correct request", () => {
  const file = new File(["image"], "photo.png", { type: "image/png" });
  const text = chatRequest("  Привет  ", null);
  assert.equal(text.path, "/messages");
  assert.deepEqual(text.body, { text: "Привет" });
  const image = chatRequest("   ", file);
  assert.equal(image.path, "/messages/image");
  assert.equal(image.body.get("text"), "");
  assert.equal(image.body.get("file").name, "photo.png");
  assert.equal(chatRequest("  Фото  ", file).body.get("text"), "Фото");
  for (const type of ["image/jpeg", "image/png", "image/webp"])
    assert.equal(chatPhotoError({ type, size: 20 * 1024 * 1024 }), "");
  assert.match(chatPhotoError({ type: "image/svg+xml", size: 10 }), /JPEG/);
  assert.match(
    chatPhotoError({ type: "image/png", size: 20 * 1024 * 1024 + 1 }),
    /20 МБ/,
  );
  assert.equal(chatRequest('', file, true).body.get('evidence'), 'true');
  assert.equal(chatRequest('', file, false, 7).body.get('issueId'), '7');
  assert.equal(chatRequest('Фото', file, false, undefined, 'a593a381-2ddd-48b1-8c43-85ed511a88a9').body.get('requestId'), 'a593a381-2ddd-48b1-8c43-85ed511a88a9');
});

test("native HEIC preparation bounds a 48 MP photo and sends only JPEG", async (t) => {
  const previousImage = globalThis.Image;
  const previousDocument = globalThis.document;
  t.after(() => {
    globalThis.Image = previousImage;
    globalThis.document = previousDocument;
  });
  const draws = [];
  let decodedPixels = [8000, 6000];
  let decodeFails = false;
  let canvasCreated = 0;
  globalThis.Image = class {
    naturalWidth = decodedPixels[0];
    naturalHeight = decodedPixels[1];
    src = "";
    async decode() {
      if (decodeFails) throw new Error("unsupported codec");
    }
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      canvasCreated++;
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillRect() {},
            drawImage(_image, _x, _y, width, height) {
              draws.push([width, height]);
            },
            set fillStyle(_value) {},
          };
        },
        toBlob(callback, type) {
          callback(new Blob(["jpeg"], { type }));
        },
      };
    },
  };
  t.mock.method(URL, "createObjectURL", () => "blob:test");
  const revoked = t.mock.method(URL, "revokeObjectURL");

  const heic = new File(["heic"], "market.heic", { type: "image/heic" });
  assert.equal(isHeicPhoto(heic), true);
  assert.equal(isHeicPhoto(new File(["x"], "market.HEIF")), true);
  assert.equal(isHeicPhoto(new File(["x"], "market.heic", { type: "image/jpeg" })), false);
  const jpeg = await prepareChatPhoto(heic);
  assert.equal(jpeg.type, "image/jpeg");
  assert.equal(jpeg.name, "photo.jpg");
  assert.deepEqual(draws, [[4096, 3072]]);
  assert.equal(revoked.mock.callCount(), 1);
  assert.equal(await prepareChatPhoto(new File(["x"], "photo.png", { type: "image/png" })).then((file) => file.type), "image/png");

  decodedPixels = [9000, 7000];
  await assert.rejects(prepareChatPhoto(heic), /60 мегапикселей/);
  assert.equal(canvasCreated, 1);
  decodeFails = true;
  await assert.rejects(prepareChatPhoto(heic), /Не удалось открыть HEIC\/HEIF/);
  const oversized = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.heif", { type: "image/heif" });
  await assert.rejects(prepareChatPhoto(oversized), /20 МБ/);
  assert.equal(canvasCreated, 1);

  let finishDecode;
  globalThis.Image = class {
    naturalWidth = 8000;
    naturalHeight = 6000;
    src = "";
    decode() {
      return new Promise((resolve) => { finishDecode = resolve; });
    }
  };
  const controller = new AbortController();
  const pending = prepareChatPhoto(heic, controller.signal);
  controller.abort();
  finishDecode();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(canvasCreated, 1);
});

test("queue and customer unread CTA use the chat anchor; shared chat renders photo and coordination", async () => {
  const [queue, card, chat, coordination, markup, image, home] = await Promise.all([
    component("pages/staff/orders/index.vue"),
    component("components/order/Card.vue"),
    component("components/order/Chat.vue"),
    component("components/order/Coordination.vue"),
    component("components/order/Markup.vue"),
    component("components/order/ChatImage.vue"),
    component("components/home/HeroCarousel.vue"),
  ]);
  assert.match(queue, /role="link"[\s\S]*tabindex="0"[\s\S]*@click="cardClick/);
  assert.match(queue, /data-card-action/);
  assert.match(queue, /staffUnread"[\s\S]*#order-chat/);
  assert.match(card, /customerUnread \? '#order-chat'/);
  assert.match(chat, /id="order-chat"/);
  assert.match(chat, /<OrderChatImage v-if="entry.image"/);
  assert.match(chat, /<OrderMarkup\s+v-if="photo \|\| markupSource"/);
  assert.match(chat, /<OrderCamera/);
  assert.doesNotMatch(chat, /capture="environment"/);
  assert.match(chat, /image\/heic,image\/heif/);
  assert.match(chat, /Подготавливаем HEIC\/HEIF/);
  assert.match(chat, /cancelPhotoPreparation/);
  assert.match(chat, /Фото перед отправкой/);
  assert.match(chat, /Повторить отправку/);
  assert.match(chat, /requestId\.value = crypto\.randomUUID\(\)/);
  assert.match(chat, /@mark="markImage"/);
  assert.match(chat, /\/messages\/\$\{attempt\.messageId\}\/revisions/);
  assert.match(chat, /Отмечено покупателем/);
  assert.match(chat, /watch\(\(\) => props\.unread/);
  assert.match(chat, /page\.unreadRevision/);
  assert.match(chat, /revisionThrough/);
  assert.match(chat, /photoVisible\(target\.messageId\)/);
  assert.match(chat, /\[data-message-id=.*\.chat-image__thumb/);
  assert.match(chat, /viewport\.value\.scrollTo/);
  assert.match(chat, /@ready="imageReady/);
  assert.match(chat, /v-if="photo \|\| markupSource"/);
  assert.match(chat, /@send="sendMarked"/);
  assert.match(chat, /Назначение фото/);
  assert.match(chat, /:expired="entry.imageExpired"/);
  assert.match(coordination, /<OrderChat/);
  assert.match(coordination, /border: 2px solid/);
  assert.match(coordination, /Продавец может прямо с рынка отправить фото прилавка/);
  assert.match(coordination, /Почти как выбрать продукт лично на рынке/);
  assert.match(markup, /@pointerdown="start"/);
  assert.match(markup, /Сообщение к фото \(необязательно\)/);
  assert.match(markup, /Отменить линию/);
  assert.match(markup, /Очистить/);
  assert.match(image, /responseType:\s*["']blob["']/);
  assert.match(image, /\/thumbnail/);
  assert.match(image, /Фото больше не хранится/);
  assert.match(image, /Открыть фото крупнее/);
  assert.match(image, /Отметить на фото/);
  assert.match(image, /\/messages\/" \+ props\.id \+ "\/image"/);
  assert.match(image, /emit\("mark", \{ id: props\.id, file: new File\(\[blob\]/);
  assert.match(image, /<OrderPhotoViewer :src="full"/);
  assert.match(home, /Выбирайте продукты прямо с прилавка/);
  assert.match(home, /Не уверены, какой товар взять\?/);
  assert.match(home, /Продавец фотографирует[\s\S]*Вы отмечаете[\s\S]*Продавец кладёт выбранный товар в заказ/);
  assert.match(home, /i-lucide-camera[\s\S]*i-lucide-pencil[\s\S]*i-lucide-shopping-basket/);
});
