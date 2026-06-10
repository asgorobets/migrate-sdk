#!/usr/bin/env node
import { runMain } from "@effect/platform-node/NodeRuntime";
import { run } from "./main.ts";

runMain(run);
