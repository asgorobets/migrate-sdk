import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourcePath = (path: string) =>
  fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@migrate-sdk\/commercetools$/u,
        replacement: sourcePath("index.ts"),
      },
      {
        find: /^@migrate-sdk\/commercetools\/(.*)$/u,
        replacement: sourcePath("$1"),
      },
    ],
  },
});
