export function queryText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function searchQuery(query: Record<string, unknown>, value: string) {
  const next = { ...query };
  delete next.page;
  const q = queryText(value);
  if (q) next.q = q;
  else delete next.q;
  return next;
}

export function isCatalog(path: string) {
  return path === "/catalog" || path.startsWith("/catalog/");
}
export function searchPath(path: string) {
  return isCatalog(path) ? path : "/catalog";
}
export function showBottomSearch(path: string) {
  return path === "/" || isCatalog(path) || path.startsWith("/product/");
}
