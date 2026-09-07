import { test } from "node:test";
import assert from "node:assert/strict";
import { backTarget } from "../app/utils/back.ts";

test("internal list → detail uses history, preserving list filters", () => {
  for (const [previous, current, fallback] of [
    ["/catalog?q=яблоки", "/product/apple", "/catalog/fruit"],
    ["/cart", "/checkout", "/cart"],
    ["/orders", "/order/1", "/orders"],
    ["/admin/products?page=2", "/admin/products/1", "/admin/products"],
    ["/staff/orders?status=NEW", "/staff/orders/1", "/staff/orders"],
  ])
    assert.equal(
      backTarget(previous, current, fallback, () => true),
      null,
    );
});

test("direct entry uses the specified fallback", () => {
  for (const previous of [null, undefined, "", 42]) {
    assert.equal(
      backTarget(previous, "/product/apple", "/catalog/fruit", () => true),
      "/catalog/fruit",
    );
  }
});

test("external, malformed, missing and same-page entries use fallback", () => {
  for (const previous of [
    "https://other.test/",
    "//other.test/",
    "/\\other.test",
    "/bad path",
    "/product/apple#photo",
  ]) {
    assert.equal(
      backTarget(previous, "/product/apple", "/catalog", () => true),
      "/catalog",
    );
  }
  assert.equal(
    backTarget("/missing", "/product/apple", "/catalog", () => false),
    "/catalog",
  );
});
