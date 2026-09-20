import { canonicalUrl, isPublicPage, pageRobots, site } from "~~/shared/utils/site";

export function useSiteSeo() {
  const route = useRoute();
  const error = useError();
  useSeoMeta({
    title: site.title,
    description: site.description,
    ogSiteName: site.name,
    ogLocale: site.locale,
    ogType: "website",
    ogTitle: site.title,
    ogDescription: site.description,
    ogUrl: () => canonicalUrl(route.path),
    robots: () => error.value ? "noindex, follow" : pageRobots(route.path, route.query),
  });
  useHead(() => ({
    link: isPublicPage(route.path) && !error.value
      ? [{ key: "canonical", rel: "canonical", href: canonicalUrl(route.path) }]
      : [],
  }));
}
