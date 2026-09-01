import { writeFileSync } from "node:fs";

const markerPath = process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER;

if (markerPath === undefined) {
  throw new Error("MIGRATE_TUI_HANGING_CONFIG_MARKER is required");
}

writeFileSync(markerPath, String(process.pid), "utf8");
await new Promise<void>(() => undefined);

export default undefined;
