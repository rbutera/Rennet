import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5210,
    strictPort: true,
    // The spike imports the REAL shared palette from packages/theme (no copy, no drift).
    fs: { allow: ["../.."] },
  },
  preview: { port: 5210, strictPort: true },
  build: { target: "es2022" },
});
