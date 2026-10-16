import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const peerOwners = {
  effect: "migrate-sdk",
  "@effect/platform-node": "migrate-sdk",
  "@commercetools/platform-sdk": "@migrate-sdk/commercetools",
  "@commercetools/importapi-sdk": "@migrate-sdk/commercetools",
  "files-sdk": "@migrate-sdk/files-sdk",
  workflow: "@migrate-sdk/workflow-sdk",
  react: "@migrate-sdk/tui",
};
const peerPaths = new Map();
function resolveModule(name, parent = import.meta.url) {
  return realpathSync(fileURLToPath(import.meta.resolve(name, parent)));
}
for (const [peer, owner] of Object.entries(peerOwners)) {
  const ownerUrl = pathToFileURL(require.resolve(`${owner}/package.json`));
  const path = resolveModule(peer, ownerUrl.href);
  peerPaths.set(peer, path);
  if (process.argv[2] === "existing") {
    assert.equal(
      path,
      resolveModule(peer),
      `${owner} must use the customer's ${peer}`
    );
  }
}
const { Effect, FileSystem, Schema } = await import(
  pathToFileURL(peerPaths.get("effect")).href
);
const checked = new Set();
function resolvePackageManifest(parent, name) {
  const path = findPackageJSON(name, parent);
  if (path) {
    return realpathSync(path);
  }
  throw new Error(`Cannot find the installed manifest for ${name}`);
}
function checkPeerResolution(parent, name) {
  const manifestPath = resolvePackageManifest(parent, name);
  if (checked.has(manifestPath)) {
    return;
  }
  checked.add(manifestPath);
  const localRequire = createRequire(manifestPath);
  const manifest = localRequire(manifestPath);
  const manifestUrl = pathToFileURL(manifestPath).href;
  for (const [peer, path] of peerPaths) {
    if (manifest.dependencies?.[peer] || manifest.peerDependencies?.[peer]) {
      assert.equal(
        resolveModule(peer, manifestUrl),
        path,
        `${name} must share the consumer's ${peer} installation`
      );
    }
  }
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const dependency of dependencies) {
    if (dependency.startsWith("@effect/") || peerPaths.has(dependency)) {
      checkPeerResolution(manifestUrl, dependency);
    }
  }
}
for (const name of process.argv.slice(3)) {
  checkPeerResolution(import.meta.url, name);
}

const nodeFileSystem = await import(
  pathToFileURL(sdkRequire.resolve("@effect/platform-node/NodeFileSystem")).href
);
const directoryExists = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(process.cwd());
  }).pipe(Effect.provide(nodeFileSystem.layer))
);
assert.equal(directoryExists, true);

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
const commercetools = await import("@migrate-sdk/commercetools");
const commercetoolsRequire = createRequire(
  require.resolve("@migrate-sdk/commercetools/package.json")
);
for (const [Service, peer] of [
  [commercetools.CommercetoolsSdk, "@commercetools/platform-sdk"],
  [commercetools.CommercetoolsImportSdk, "@commercetools/importapi-sdk"],
]) {
  const { ApiRoot } = commercetoolsRequire(peer);
  const apiRoot = new ApiRoot({
    executeRequest: () => {
      throw new Error("No network requests expected");
    },
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* Service;
      assert.ok(client.project);
    }).pipe(
      Effect.provide(
        Service.layerFromApiRoot({ apiRoot, projectKey: "peer-fixture" })
      )
    )
  );
}
await import("@migrate-sdk/workflow-sdk");
await import("@migrate-sdk/files-sdk/source");
await import("@migrate-sdk/files-sdk/destination");
process.stdout.write(
  "SDK migration and adapters share customer runtime dependencies\n"
);
