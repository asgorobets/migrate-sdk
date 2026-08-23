import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["src/app.test.tsx", "node_modules/**"],
  },
});
