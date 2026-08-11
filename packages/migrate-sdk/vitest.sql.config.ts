import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourcePath = (path: string) =>
  fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^migrate-sdk$/u, replacement: sourcePath("index.ts") },
      { find: /^migrate-sdk\/(.*)$/u, replacement: sourcePath("$1") },
    ],
  },
  test: {
    include: ["src/stores/sql/**/*.integration.test.ts"],
    testTimeout: 30_000,
  },
});
