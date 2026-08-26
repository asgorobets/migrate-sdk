import { Effect } from "effect";
import { MigrationExecutable } from "migrate-sdk";

let acquisitions = 0;
let releases = 0;

export const acquireScopedExecutable = Effect.sync(() => {
  acquisitions += 1;

  return MigrationExecutable.inlineService;
});

export const releaseScopedExecutable = Effect.sync(() => {
  releases += 1;
});

export const resetScopedExecutableState = (): void => {
  acquisitions = 0;
  releases = 0;
};

export const scopedExecutableState = () => ({ acquisitions, releases });
