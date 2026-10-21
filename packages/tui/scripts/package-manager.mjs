import { basename } from "node:path";

/** Invoke the current pinned pnpm without passing Windows paths through a shell. */
export function packageManagerCommand(args) {
  const entry = process.env.npm_execpath;
  if (
    !(entry && basename(entry).startsWith("pnpm")) ||
    entry.endsWith(".cmd")
  ) {
    throw new Error(
      "Run binary packaging and acceptance through the repository's pnpm scripts"
    );
  }
  return entry.endsWith("js")
    ? { executable: process.execPath, args: [entry, ...args] }
    : { executable: entry, args };
}
