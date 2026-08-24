/** @effect-diagnostics asyncFunction:skip-file */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  markCatalogFixtureDirectory,
  prepareCatalogFixtureDirectory,
} from "./fixture-directory.ts";

describe("SQLite catalog fixture directory", () => {
  it("refuses to recursively reset an unrecognized directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "migrate-sdk-catalog-test-"));
    const sentinel = join(root, "keep.txt");
    await writeFile(sentinel, "keep");

    try {
      await expect(prepareCatalogFixtureDirectory(root, true)).rejects.toThrow(
        "not a recognized SQLite catalog fixture"
      );
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resets a directory created by the catalog fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "migrate-sdk-catalog-test-"));
    const fixture = join(root, "fixture");
    await mkdir(fixture);
    await markCatalogFixtureDirectory(fixture);
    await writeFile(join(fixture, "state.sqlite"), "fixture");

    try {
      await prepareCatalogFixtureDirectory(fixture, true);
      expect(existsSync(fixture)).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
