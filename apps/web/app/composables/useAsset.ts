export function useAsset() {
  const apiBase = useRuntimeConfig().public.apiBase;
  return (url: string): string => {
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("/uploads/products/")) return new URL(url, apiBase).href;
    return url;
  };
}
