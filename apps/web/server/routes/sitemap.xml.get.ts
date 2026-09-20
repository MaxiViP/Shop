import type { Category } from "../../app/types/category";
import type { ProductListResponse } from "../../app/types/product";
import { canonicalUrl } from "../../shared/utils/site";

function xml(value: string) {
  return value.replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[char]!);
}

export default defineCachedEventHandler(async (event) => {
  const baseURL = useRuntimeConfig(event).public.apiBase;
  const options = { baseURL, timeout: 10000, retry: 0 } as const;
  try {
    const [categories, first] = await Promise.all([
      $fetch<Category[]>("/categories", options),
      $fetch<ProductListResponse>("/products", { ...options, query: { limit: 60, page: 1 } }),
    ]);
    // A single sitemap is bounded by the protocol's 50,000 URL limit.
    if (!Number.isInteger(first.pages) || first.pages < 0 || first.pages > 834 || first.total + categories.length + 3 > 50000) {
      throw new Error("Catalog needs a sitemap index");
    }
    const urls = new Set(["/", "/catalog", "/delivery"]);
    for (const category of categories) {
      if (category.indexable !== false) urls.add(`/catalog/${encodeURIComponent(category.slug)}`);
    }
    function addPage(page: ProductListResponse) {
      for (const item of page.items) {
        if (item.indexable !== false) urls.add(`/product/${encodeURIComponent(item.slug)}`);
      }
    }
    addPage(first);
    // Keep upstream pressure bounded when the catalog grows to thousands of products.
    for (let page = 2; page <= first.pages; page += 4) {
      const batch = await Promise.all(Array.from(
        { length: Math.min(4, first.pages - page + 1) },
        (_, index) => $fetch<ProductListResponse>("/products", {
          ...options, query: { limit: 60, page: page + index },
        }),
      ));
      batch.forEach(addPage);
    }
    setResponseHeader(event, "Content-Type", "application/xml; charset=utf-8");
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + [...urls].map((path) => `<url><loc>${xml(canonicalUrl(path))}</loc></url>`).join("\n")
      + "\n</urlset>";
  } catch {
    // An upstream failure must not become a successful, empty sitemap.
    throw createError({ statusCode: 503, statusMessage: "Sitemap temporarily unavailable" });
  }
}, { maxAge: 60, swr: false });
