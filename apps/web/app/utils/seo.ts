import type { Category } from "~/types/category";
import type { Product } from "~/types/product";
import { canonicalUrl, site } from "~~/shared/utils/site";

export interface Breadcrumb {
  label: string;
  to: string;
}

export function seoText(value: string | null | undefined, fallback: string) {
  const text = (value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const clean = text || fallback;
  return clean.length > 180 ? clean.slice(0, 177).trimEnd() + "…" : clean;
}

export function categorySeo(category: Category) {
  return {
    title: category.seoTitle?.trim() || `${category.name} с рынка с доставкой по Москве — ${site.name}`,
    description: seoText(category.seoDescription || category.description,
      `${category.name} с рынка с доставкой по Москве. Выбирайте продукты в ${site.name} и заказывайте доставку на дом.`),
  };
}

export function productSeo(product: Product) {
  return {
    title: product.seoTitle?.trim() || `${product.name} купить с доставкой по Москве — ${site.name}`,
    description: seoText(product.seoDescription || product.description,
      `${product.name} с рынка с доставкой по Москве. Цена, описание и заказ онлайн в ${site.name}.`),
  };
}

export function publicImageUrl(value: string) {
  try {
    const url = new URL(value, site.url);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function breadcrumbSchema(items: Breadcrumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem", position: index + 1, name: item.label, item: canonicalUrl(item.to),
    })),
  };
}

export function productSchema(product: Product) {
  const url = canonicalUrl(`/product/${encodeURIComponent(product.slug)}`);
  const price = (product.price / 100).toFixed(2);
  const image = product.images.map(({ url }) => publicImageUrl(url)).filter(Boolean);
  return {
    "@context": "https://schema.org", "@type": "Product",
    "@id": `${url}#product`, name: product.name, sku: String(product.id),
    category: product.category.name,
    ...(product.description?.trim() ? { description: product.description.trim() } : {}),
    ...(image.length ? { image } : {}),
    offers: {
      "@type": "Offer", url, price, priceCurrency: "RUB",
      seller: { "@id": `${site.url}/#store` },
      priceSpecification: {
        "@type": "UnitPriceSpecification", price, priceCurrency: "RUB",
        referenceQuantity: {
          "@type": "QuantitativeValue", value: product.priceQty,
          unitCode: product.unit === "GRAM" ? "GRM" : "C62",
          unitText: { GRAM: "г", PIECE: "шт.", BUNCH: "пучок", PACK: "уп." }[product.unit],
        },
      },
      // Publication (active) is not inventory. Add availability when the API exposes it.
    },
  };
}

export function storeSchema() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${site.url}/#website`, name: site.name,
        url: `${site.url}/`, inLanguage: site.language, publisher: { "@id": `${site.url}/#store` } },
      { "@type": "OnlineStore", "@id": `${site.url}/#store`, name: site.name,
        url: `${site.url}/`, description: site.about,
        areaServed: [
          { "@type": "City", name: site.delivery.city },
          ...site.delivery.priorityAreas.map((name) => ({ "@type": "Place", name })),
        ],
      },
    ],
  };
}

export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
