import { deliveryProvider } from "../../app/utils/delivery";

export const site = {
  name: "KorzinaMarket",
  url: "https://korzinamarket.ru",
  language: "ru-RU",
  locale: "ru_RU",
  title: "Доставка продуктов с рынка по Москве — KorzinaMarket",
  description: "Свежие овощи, фрукты, зелень и другие продукты с рынка с доставкой по Москве. Быстрая доставка доступна в районе Багратионовской, Фили-Давыдково и ближайших районах.",
  about: "KorzinaMarket — интернет-магазин свежих продуктов с рынка с доставкой по Москве.",
  delivery: {
    city: "Москва",
    priorityAreas: ["район метро Багратионовская", "Фили-Давыдково"],
    nearby: "прилегающие районы",
    providerLabel: deliveryProvider.YANDEX,
    pricingMode: "address-and-distance",
    priorityText: "Особенно быстрая доставка возможна в районе метро Багратионовская, Фили-Давыдково и прилегающих районах.",
    pricingText: "Стоимость доставки зависит от адреса, расстояния и текущего расчёта. Чем дальше адрес от основной зоны обслуживания, тем выше стоимость доставки. Фиксированного тарифа и гарантированного времени для всех адресов нет.",
  },
} as const;

export function canonicalUrl(path = "/") {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  return new URL("/" + pathname.replace(/^\/+|\/+$/g, ""), site.url).href;
}

export function isPublicPage(path: string) {
  return /^\/(?:catalog(?:\/[^/]+)?|product\/[^/]+|delivery)?\/?$/.test(path);
}

export function pageRobots(path: string, query: Record<string, unknown> = {}) {
  const filtered = path.startsWith("/catalog") && Object.keys(query).some(
    (key) => !/^utm_/i.test(key) && !["gclid", "yclid", "fbclid"].includes(key),
  );
  return isPublicPage(path) && !filtered ? "index, follow" : "noindex, follow";
}
