import assert from "node:assert/strict";
import test from "node:test";
import {
  capitalizeFirst,
  formatPhone,
  phoneEdit,
  phoneValue,
} from "../app/utils/input-format.ts";

test("Russian phone formats share one canonical API value", () => {
  for (const value of [
    "89057353580",
    "79057353580",
    "+79057353580",
    "+7 9057353580",
    "8 (905) 735-35-80",
    "9057353580",
  ]) {
    assert.equal(formatPhone(value), "+7 905 735 35 80");
    assert.equal(phoneValue(value), "+79057353580");
  }
});

test("progressive phone input, empty values and length limit", () => {
  for (const [raw, expected] of [
    ["", ""],
    ["+", ""],
    ["8", "+7"],
    ["8905", "+7 905"],
    ["8905735", "+7 905 735"],
    ["89057353580999", "+7 905 735 35 80"],
  ]) {
    assert.equal(formatPhone(raw), expected);
  }
});

test("phone caret stays by the edited digit rather than jumping to the end", () => {
  assert.deepEqual(
    phoneEdit("+7 915 735 35 80", 5, "+7 905 735 35 80", "insertText"),
    { value: "+7 915 735 35 80", caret: 5 },
  );
  assert.deepEqual(phoneEdit("905", 3, "", "insertFromPaste"), {
    value: "+7 905",
    caret: 6,
  });
  assert.deepEqual(phoneEdit("8 (905) 735-35-80", 17, "", "insertFromPaste"), {
    value: "+7 905 735 35 80",
    caret: 16,
  });
});

test("backspace and delete across separators remove adjacent digits", () => {
  assert.deepEqual(
    phoneEdit(
      "+7 905735 35 80",
      6,
      "+7 905 735 35 80",
      "deleteContentBackward",
    ),
    { value: "+7 907 353 58 0", caret: 5 },
  );
  assert.deepEqual(
    phoneEdit("+7 905735 35 80", 6, "+7 905 735 35 80", "deleteContentForward"),
    { value: "+7 905 353 58 0", caret: 6 },
  );
  assert.deepEqual(phoneEdit("+", 1, "+7", "deleteContentBackward"), {
    value: "",
    caret: 0,
  });
  assert.deepEqual(phoneEdit("", 0, "+7 905", "deleteContentBackward"), {
    value: "",
    caret: 0,
  });
});

test("capitalize only ordinary lowercase first words, preserve mixed-case brands and suffix", () => {
  for (const [raw, expected] of [
    ["максим", "Максим"],
    ["москва", "Москва"],
    ["улица барклая", "Улица барклая"],
    ["нарезка фруктов", "Нарезка фруктов"],
    ["john DOE", "John DOE"],
    ["ёлка", "Ёлка"],
    ["iPhone", "iPhone"],
    ["eSIM", "eSIM"],
    ["мВидео", "мВидео"],
    ["Москва", "Москва"],
    ["", ""],
    ["123", "123"],
  ]) {
    assert.equal(capitalizeFirst(raw), expected);
  }
});
