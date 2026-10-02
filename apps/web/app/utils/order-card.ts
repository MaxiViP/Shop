const controls =
  "a, button, summary, input, textarea, select, [data-card-action]";

export function cardClickNavigates(target: EventTarget | null) {
  return !(
    target &&
    "closest" in target &&
    (target as Element).closest(controls)
  );
}

export function cardKeyNavigates(
  event: Pick<KeyboardEvent, "target" | "currentTarget" | "key">,
) {
  return (
    event.target === event.currentTarget &&
    (event.key === "Enter" || event.key === " ")
  );
}
