#!/usr/bin/env node
import { register } from "tsx/esm/api";

const tsxLoader = register({ namespace: "migrate-sdk-bin" });

await tsxLoader.import(
  new URL("../src/cli/bin.ts", import.meta.url).href,
  import.meta.url
);
