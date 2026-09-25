const orderPath = /^\/order\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPath = /^\/(?:catalog|product)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const customerPages = new Set([
  "/", "/catalog", "/orders", "/profile", "/cart", "/favorites", "/delivery",
]);

export function telegramReturnTo(value: unknown): string {
  if (typeof value !== "string" || value.length > 189) return "/catalog";
  return customerPages.has(value) || orderPath.test(value) || slugPath.test(value)
    ? value
    : "/catalog";
}
