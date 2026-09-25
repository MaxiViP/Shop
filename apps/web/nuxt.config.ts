export default defineNuxtConfig({
  compatibilityDate: "2026-08-30",

  devServer: {
    host: "127.0.0.1",
    port: 3000,
  },

  modules: ["@nuxt/ui", "@pinia/nuxt", "@nuxt/eslint"],

  app: {
    head: {
      htmlAttrs: { lang: "ru-RU" },

      meta: [
        { property: "og:locale", content: "ru_RU" },
        { name: "theme-color", content: "#ffffff" },
      ],

      link: [
        {
          rel: "icon",
          href: "/favicon.ico",
          sizes: "48x48",
        },
        {
          rel: "icon",
          type: "image/png",
          sizes: "16x16",
          href: "/favicons/favicon-16x16.png",
        },
        {
          rel: "icon",
          type: "image/png",
          sizes: "32x32",
          href: "/favicons/favicon-32x32.png",
        },
        {
          rel: "icon",
          type: "image/png",
          sizes: "48x48",
          href: "/favicons/favicon-48x48.png",
        },
        {
          rel: "apple-touch-icon",
          sizes: "180x180",
          href: "/favicons/apple-touch-icon.png",
        },
        {
          rel: "icon",
          type: "image/png",
          sizes: "192x192",
          href: "/favicons/android-chrome-192x192.png",
        },
        {
          rel: "icon",
          type: "image/png",
          sizes: "512x512",
          href: "/favicons/android-chrome-512x512.png",
        },
        {
          rel: "manifest",
          href: "/site.webmanifest",
        },
      ],
    },
  },

  icon: {
    clientBundle: {
      // Include application icons as well as Nuxt UI defaults, before any render.
      scan: { globInclude: ["app/**/*.{vue,ts}"] },
      sizeLimitKb: 32,
    },
    fallbackToApi: false,
  },

  css: ["~/assets/css/main.css"],

  colorMode: {
    preference: "system",
    fallback: "light",
    classSuffix: "",
    storage: "localStorage",
    storageKey: "nuxt-color-mode",
    // Keep active timer transitions (HeaderNotice) intact when switching themes.
    disableTransition: false,
  },

  runtimeConfig: {
    public: {
      apiBase: "http://127.0.0.1:4001/api",
      siteUrl: "https://korzinamarket.ru",
      telegramCustomerBotUrl: "",
      pickupName: "ТЦ «Багратионовский»",
      pickupAddress: "ул. Барклая, 10, Москва",
    },
  },

  devtools: {
    enabled: true,
  },
});
