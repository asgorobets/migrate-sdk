import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["src/**/*.integration.test.ts"],
    include: ["src/**/*.test.ts"],
  },
});
