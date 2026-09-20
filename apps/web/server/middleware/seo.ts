import { isPublicPage, pageRobots } from "../../shared/utils/site";

export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname;
  if (path.startsWith("/api/") || path.startsWith("/_") || /\.[a-z0-9]+$/i.test(path)) return;
  if (!isPublicPage(path) || pageRobots(path, getQuery(event)) === "noindex, follow") {
    setResponseHeader(event, "X-Robots-Tag", "noindex, follow");
  }
});
