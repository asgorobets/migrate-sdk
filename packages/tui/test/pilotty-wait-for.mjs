import { spawnSync } from "node:child_process";

const [binary, session, timeoutInput, pattern] = process.argv.slice(2);
const timeoutMs = Number(timeoutInput);

try {
  if (!(binary && session && pattern)) {
    throw new Error(
      "Expected Pilotty binary, session, timeout in ms, and text"
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Pilotty wait timeout must be a positive safe integer");
  }

  const deadline = performance.now() + timeoutMs;
  while (true) {
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) {
      throw new Error(
        `Timeout waiting for '${pattern}' in session '${session}' after ${timeoutMs}ms`
      );
    }
    // Pilotty 0.0.11 caps client requests at 30s, independently of --timeout.
    const result = spawnSync(
      binary,
      [
        "wait-for",
        "-s",
        session,
        "-t",
        String(Math.min(10_000, remainingMs)),
        pattern,
      ],
      { encoding: "utf8", timeout: remainingMs + 1000 }
    );
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      break;
    }
    if (
      !result.stderr
        .trim()
        .startsWith("Error: [COMMAND_FAILED] Timeout waiting for ")
    ) {
      throw new Error(
        [result.stdout, result.stderr].filter(Boolean).join("\n").trim() ||
          `Pilotty exited with ${result.signal ?? result.status}`
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
