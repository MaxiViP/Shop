export default defineNuxtConfig({
  compatibilityDate: "2026-08-30",

  devServer: {
    host: "127.0.0.1",
    port: 3000,
  },

  modules: ["@nuxt/ui", "@pinia/nuxt", "@nuxt/eslint"],

  css: ["~/assets/css/main.css"],

  runtimeConfig: {
    public: {
      apiBase: "http://127.0.0.1:4001/api",
      siteUrl: "",
      pickupName: "ТЦ «Багратионовский»",
      pickupAddress: "ул. Барклая, 10, Москва",
    },
  },

  devtools: {
    enabled: true,
  },
});
