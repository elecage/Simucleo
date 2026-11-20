import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./scripts/precache.mjs";

export default defineConfig({
  plugins: [
    react(),
    // Offline app (M29): dist/sw.js with every built file precached.
    serviceWorkerPlugin({ template: "sw/service-worker.js", lessons: "lessons" }),
  ],
  base: "./",
});
