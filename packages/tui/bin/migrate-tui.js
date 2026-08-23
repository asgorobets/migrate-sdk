#!/usr/bin/env node

import { main } from "./launcher.js";

try {
  process.exitCode = await main();
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`migrate-tui: ${message}\n`);
  process.exitCode = 1;
}
