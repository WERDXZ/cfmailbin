import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../dist/ui",
  },
  plugins: [preact()],
  root: "src/ui",
  server: {
    port: 5173,
    proxy: {
      // Preserve the browser's Host so the backend's same-origin write check
      // sees the frontend origin. Vite's string shorthand rewrites this header.
      "/api/": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/health": "http://127.0.0.1:8000",
    },
  },
});
