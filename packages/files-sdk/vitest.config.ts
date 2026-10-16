import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const sourcePath = (path: string) =>
  fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@migrate-sdk\/files-sdk$/u,
        replacement: sourcePath("index.ts"),
      },
      {
        find: /^@migrate-sdk\/files-sdk\/(.*)$/u,
        replacement: sourcePath("$1"),
      },
    ],
  },
  test: {
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
  },
});
