// biome-ignore-all assist/source/organizeImports: Public testing entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public testing subpath entrypoint intentionally re-exports supported test helpers.

export type {
  RecordedCommercetoolsRequest,
  RecordingCommercetoolsApiRoot,
} from "./products.ts";
export { makeRecordingCommercetoolsApiRoot } from "./products.ts";
