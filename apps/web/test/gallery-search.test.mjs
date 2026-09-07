import { test } from "node:test";
import assert from "node:assert/strict";
import { ref, nextTick } from "vue";
import { useProductGallery } from "../app/composables/useProductGallery.ts";
import {
  queryText,
  searchQuery,
  searchPath,
  showBottomSearch,
} from "../app/utils/search.ts";

test("gallery starts at main, changes selection and resets for another product", async () => {
  const images = ref([
    { url: "/main", alt: null },
    { url: "/second", alt: "Second" },
  ]);
  const gallery = useProductGallery(() => images.value);
  assert.equal(gallery.current.value.url, "/main");
  assert.equal(gallery.hasThumbnails.value, true);
  gallery.select(1);
  assert.equal(gallery.current.value.url, "/second");
  gallery.select(99);
  assert.equal(gallery.current.value.url, "/second");
  images.value = [{ url: "/next-product", alt: null }];
  await nextTick();
  assert.equal(gallery.selected.value, 0);
  assert.equal(gallery.current.value.url, "/next-product");
  assert.equal(gallery.hasThumbnails.value, false);
});

test("empty gallery safely returns placeholder state", () => {
  const gallery = useProductGallery(() => []);
  gallery.select(0);
  assert.equal(gallery.current.value, null);
  assert.equal(gallery.hasThumbnails.value, false);
});

test("search preserves category/sort, normalizes q and resets pagination", () => {
  const query = { q: "old", page: "3", sort: "price", category: "fruit" };
  assert.deepEqual(searchQuery(query, "  томаты   черри  "), {
    q: "томаты черри",
    sort: "price",
    category: "fruit",
  });
  assert.equal(query.page, "3");
  assert.equal(queryText(["invalid"]), "");
  assert.equal(searchPath("/product/apple"), "/catalog");
  assert.equal(searchPath("/"), "/catalog");
  assert.equal(searchPath("/catalog/fruits"), "/catalog/fruits");
});

test("clear removes only query and pagination", () => {
  assert.deepEqual(searchQuery({ q: "apple", page: "2", sort: "new" }, ""), {
    sort: "new",
  });
});

test("bottom search is limited to storefront routes", () => {
  for (const path of ["/", "/catalog", "/catalog/fruits", "/product/apple"])
    assert.equal(showBottomSearch(path), true);
  for (const path of [
    "/admin/products",
    "/staff/orders",
    "/checkout",
    "/cart",
    "/orders",
    "/order/1",
    "/track/token",
    "/profile",
    "/catalogue",
  ])
    assert.equal(showBottomSearch(path), false);
});
