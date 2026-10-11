import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Build-Version der App (kommt im Docker-Build aus GitHub Actions), sichtbar in der Fußzeile
  define: { __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? "dev") },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/apple-touch-icon.png", "icons/icon.svg"],
      manifest: {
        name: "Kopfkino",
        short_name: "Kopfkino",
        description: "Gedacht. Eingesprochen. Gelacht.",
        lang: "de",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#FFF4D6",
        theme_color: "#FF5A5F",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // API-Aufrufe nie aus dem Cache bedienen – Guthaben, Jobs und Status müssen live sein.
        navigateFallbackDenylist: [/^\/api\//, /^\/test\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: { "/api": "http://localhost:3000" },
  },
});
