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
      apiBase: "http://127.0.0.1:3001/api",
      siteUrl: "",
    },
  },

  devtools: {
    enabled: true,
  },
});
