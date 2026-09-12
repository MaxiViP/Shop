export function phoneValue(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (!digits) return "";
  digits = /^[78]/.test(digits) ? `7${digits.slice(1)}` : `7${digits}`;
  return `+${digits.slice(0, 11)}`;
}

export function formatPhone(value: string): string {
  const digits = phoneValue(value).slice(1);
  if (!digits) return "";
  return `+${[digits.slice(0, 1), digits.slice(1, 4), digits.slice(4, 7), digits.slice(7, 9), digits.slice(9, 11)].filter(Boolean).join(" ")}`;
}

export function capitalizeFirst(value: string): string {
  // Preserve brands/mixed-case words (iPhone, eSIM, мВидео) and the remaining text.
  const word = value.match(/^[a-zа-яё]+/iu)?.[0];
  if (!word || word !== word.toLowerCase()) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function phoneEdit(
  raw: string,
  caret: number,
  previous: string,
  inputType = "",
) {
  let digits = raw.replace(/\D/g, "");
  let before = raw.slice(0, caret).replace(/\D/g, "").length;
  // Deleting a separator should remove the adjacent digit, not recreate the space forever.
  if (
    inputType.startsWith("delete") &&
    digits === previous.replace(/\D/g, "")
  ) {
    const index = inputType === "deleteContentBackward" ? before - 1 : before;
    if (index >= 0 && index < digits.length) {
      digits = digits.slice(0, index) + digits.slice(index + 1);
      if (inputType === "deleteContentBackward") before--;
    }
  }
  if (digits && !/^[78]/.test(digits)) before++;
  const value = formatPhone(digits);
  let position = 0;
  let count = 0;
  while (position < value.length && count < before) {
    if (/\d/.test(value[position]!)) count++;
    position++;
  }
  return { value, caret: position };
}
