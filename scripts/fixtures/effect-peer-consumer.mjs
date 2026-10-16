import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  SourceIdentity,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("migrate-sdk/package.json"));
const effectPath = realpathSync(sdkRequire.resolve("effect"));
const { Effect, Schema } = await import(pathToFileURL(effectPath).href);
if (process.argv[2] === "existing") {
  assert.equal(
    effectPath,
    realpathSync(require.resolve("effect")),
    "SDK must use the customer's explicitly installed Effect"
  );
}
const checked = new Set();
function checkEffectResolution(parent, name) {
  const manifestPath = parent.resolve(`${name}/package.json`);
  if (checked.has(manifestPath)) {
    return;
  }
  checked.add(manifestPath);
  const localRequire = createRequire(manifestPath);
  const manifest = localRequire(manifestPath);
  if (manifest.dependencies?.effect || manifest.peerDependencies?.effect) {
    assert.equal(
      realpathSync(localRequire.resolve("effect")),
      effectPath,
      `${name} must share the consumer's Effect installation`
    );
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@effect/")) {
      checkEffectResolution(localRequire, dependency);
    }
  }
}
for (const name of process.argv.slice(3)) {
  checkEffectResolution(require, name);
}

const migrated = [];
const definition = MigrationDefinition.make({
  id: "effect-peer-fixture",
  source: InMemorySource.make({
    identity: SourceIdentity.make({
      id: "effect-peer-fixture@v1",
      schema: SourceIdentity.key("id", Schema.NonEmptyString),
    }),
    sourceSchema: Schema.Struct({ title: Schema.String }),
    items: [
      { identityKey: "one", version: "v1", item: { title: "Shared Effect" } },
    ],
  }),
  store: InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState()),
  process: (item) =>
    Effect.sync(() => {
      migrated.push(item.item.title);
    }),
});
const execution = MigrationExecution.make({
  registry: MigrationDefinitionRegistry.make({ definitions: [definition] }),
});
const summary = await Effect.runPromise(
  Effect.gen(function* () {
    const started = yield* execution.run({ all: true });
    if (started.kind === "completed") {
      return started.summary;
    }
    assert.ok(started.handle);
    const result = yield* started.handle.wait;
    assert.equal(result.kind, "finished");
    return result.summary;
  })
);
assert.equal(summary.status, "succeeded");
assert.deepEqual(migrated, ["Shared Effect"]);
await import("@migrate-sdk/commercetools");
await import("@migrate-sdk/workflow-sdk");
process.stdout.write(
  "SDK migration and adapters share one Effect installation\n"
);
