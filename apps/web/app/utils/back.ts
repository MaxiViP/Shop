// null means the router can safely use its previous history entry.
export function backTarget(
  previous: unknown,
  current: string,
  fallback: string,
  exists: (path: string) => boolean,
): string | null {
  if (
    typeof previous !== "string" ||
    !previous.startsWith("/") ||
    previous.startsWith("//") ||
    /[\\\s]/.test(previous) ||
    previous.split(/[?#]/)[0] === current.split(/[?#]/)[0] ||
    !exists(previous)
  )
    return fallback;
  return null;
}
