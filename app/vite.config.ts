import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { global: "globalThis" },
  server: { allowedHosts: true },
  resolve: { alias: { buffer: "buffer/" } },
});
