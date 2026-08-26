import { writeFile } from "node:fs/promises";

const pidPath = process.env.MIGRATE_TUI_RECONNECT_SERVER_PID_PATH;

if (pidPath === undefined || pidPath === "") {
  throw new Error("MIGRATE_TUI_RECONNECT_SERVER_PID_PATH is required");
}

await writeFile(pidPath, String(process.pid), "utf8");
await import("../../src/server/node-entry.ts");
