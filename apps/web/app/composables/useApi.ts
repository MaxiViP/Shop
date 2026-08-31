export const useApi = createUseFetch((options) => ({
  ...options,

  baseURL: useRuntimeConfig().public.apiBase,

  credentials: "include",

  headers: import.meta.server ? useRequestHeaders(["cookie"]) : options.headers,
}));

export function useApiClient() {
  return $fetch.create({
    baseURL: useRuntimeConfig().public.apiBase,
    credentials: "include",
  });
}
