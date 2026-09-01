if ("Bun" in globalThis) {
  throw new Error("The migration configuration must not load in Bun");
}

// biome-ignore lint/performance/noBarrelFile: This fixture adds a runtime guard to the shared package smoke config.
export { default } from "../../examples/packaging.config.ts";
