import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: path.resolve(import.meta.dirname, "server", "_core", "index.ts"),
    outDir: path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: false,
    target: "node22",
    rollupOptions: {
      output: {
        entryFileNames: "index.js",
      },
    },
  },
});
