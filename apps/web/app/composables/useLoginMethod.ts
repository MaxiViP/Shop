import { ref } from "vue";

type Method = "OTP" | "PASSWORD";
type Mode = "PHONE" | "CHECKING_METHOD" | Method;

export function fullPhone(value: string): boolean {
  if (!/^[+\d\s()-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("+"))
    return digits.length === 11 && digits.startsWith("7");
  return (
    (digits.length === 10 && !/^[78]/.test(digits)) ||
    (digits.length === 11 && /^[78]/.test(digits))
  );
}

export function useLoginMethod(
  request: (phone: string) => Promise<{ method: Method }>,
) {
  const mode = ref<Mode>("PHONE");
  const error = ref<unknown>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;

  function reset() {
    clearTimeout(timer);
    revision++;
    mode.value = "PHONE";
    error.value = null;
  }

  function change(phone: string, delay = 400) {
    reset();
    if (!fullPhone(phone)) return;
    const current = revision;
    mode.value = "CHECKING_METHOD";
    timer = setTimeout(async () => {
      try {
        const result = await request(phone);
        if (current === revision) mode.value = result.method;
      } catch (cause) {
        if (current === revision) {
          mode.value = "PHONE";
          error.value = cause;
        }
      }
    }, delay);
  }

  return { mode, error, change, reset };
}
