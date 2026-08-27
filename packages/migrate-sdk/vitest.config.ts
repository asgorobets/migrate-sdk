import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const sourcePath = (path: string) =>
  fileURLToPath(new URL(`./src/${path}`, import.meta.url));
const fixturePath = (path: string) =>
  fileURLToPath(new URL(`../../fixtures/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fixtures\/catalog$/u,
        replacement: fixturePath("catalog/fixture.ts"),
      },
      { find: /^migrate-sdk$/u, replacement: sourcePath("index.ts") },
      { find: /^migrate-sdk\/(.*)$/u, replacement: sourcePath("$1") },
    ],
  },
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.integration.test.ts"],
  },
});
