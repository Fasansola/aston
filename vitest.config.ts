import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    // Mirror tsconfig's "@/*" → "./*" so tests import modules the same way the app does.
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
});
