import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, "../dist/distribution");
const info = JSON.parse(
  await readFile(resolve(directory, "distribution.json"), "utf8")
);
const archives = (await readdir(resolve(directory, "archives"))).map((name) =>
  resolve(directory, "archives", name)
);
execFileSync(
  "gh",
  [
    "release",
    "upload",
    `@migrate-sdk/tui@${info.version}`,
    ...archives,
    resolve(directory, "SHA256SUMS"),
    resolve(directory, "distribution.json"),
  ],
  { stdio: "inherit" }
);
