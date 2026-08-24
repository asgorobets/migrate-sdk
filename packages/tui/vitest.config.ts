import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "src/app.test.tsx",
      "src/render-session.test.ts",
      "node_modules/**",
    ],
  },
});
