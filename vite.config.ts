import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { attachIptvRelay } from "./scripts/iptv-relay.mjs";

function iptvRelayPlugin() {
  return {
    name: "perde-iptv-relay",
    configureServer(server) {
      attachIptvRelay(server.middlewares);
    },
    configurePreviewServer(server) {
      attachIptvRelay(server.middlewares);
    },
  };
}

export default defineConfig({
  appType: "spa",
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    cssMinify: "lightningcss",
    target: "chrome87",
    assetsInlineLimit: 4096,
    modulePreload: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [iptvRelayPlugin(), tailwindcss(), preact()],
});
