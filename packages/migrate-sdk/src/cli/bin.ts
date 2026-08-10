#!/usr/bin/env node
import { makeRunMain } from "effect/Runtime";
import { isMigrationCliInterruptScopeActive } from "./interrupts.ts";
import { run } from "./main.ts";

const runMain = makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false;

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    teardown(exit, (code) => {
      if (receivedSignal || code !== 0) {
        process.exit(code);
      }
    });
  });

  function interruptMain() {
    receivedSignal = true;
    fiber.interruptUnsafe(fiber.id);
  }

  function onSigint() {
    if (!isMigrationCliInterruptScopeActive()) {
      interruptMain();
    }
  }

  function onSigterm() {
    interruptMain();
  }

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
});

runMain(run);
