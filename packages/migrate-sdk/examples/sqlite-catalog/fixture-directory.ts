/** @effect-diagnostics nodeBuiltinImport:skip-file */
/** @effect-diagnostics asyncFunction:skip-file */
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixtureMarkerFileName = ".migrate-sdk-sqlite-catalog";
const fixtureMarkerContents = "migrate-sdk sqlite catalog fixture\n";

const markerPath = (dataDirectory: string): string =>
  join(dataDirectory, fixtureMarkerFileName);

export const prepareCatalogFixtureDirectory = async (
  dataDirectory: string,
  shouldReset: boolean
): Promise<void> => {
  if (!existsSync(dataDirectory)) {
    return;
  }

  if (!shouldReset) {
    throw new Error(
      `Catalog fixture already exists at ${dataDirectory}. Pass --reset to replace it.`
    );
  }

  const marker = await readFile(markerPath(dataDirectory), "utf8").catch(
    () => null
  );
  if (marker !== fixtureMarkerContents) {
    throw new Error(
      `Refusing to reset ${dataDirectory} because it is not a recognized SQLite catalog fixture.`
    );
  }

  await rm(dataDirectory, { recursive: true });
};

export const markCatalogFixtureDirectory = async (
  dataDirectory: string
): Promise<void> => {
  await writeFile(markerPath(dataDirectory), fixtureMarkerContents);
};
