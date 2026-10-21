import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const sdkDirectory = resolve(repositoryDirectory, "packages/migrate-sdk");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

const temporary = await mkdtemp(join(tmpdir(), "migrate-files-package-"));
try {
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  for (const directory of [sdkDirectory, packageDirectory]) {
    run(pnpm, ["pack", "--pack-destination", temporary], directory);
  }
  const sdk = JSON.parse(
    await readFile(join(sdkDirectory, "package.json"), "utf8")
  );
  const integration = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8")
  );
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "files-package-consumer",
      private: true,
      type: "module",
      packageManager: "pnpm@10.34.5",
    })
  );
  run(
    pnpm,
    [
      "add",
      "--ignore-scripts",
      "--save-exact",
      join(temporary, `migrate-sdk-${sdk.version}.tgz`),
      join(temporary, `migrate-sdk-files-sdk-${integration.version}.tgz`),
      "effect@4.0.5",
      "files-sdk@3.1.1",
    ],
    consumer
  );
  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import { Effect } from "effect";
import { FilesSDKObject } from "@migrate-sdk/files-sdk";
import { FilesSDKSource, FilesSDKDocumentFetchers } from "@migrate-sdk/files-sdk/source";
import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { FilesSDKMigrationStore } from "@migrate-sdk/files-sdk/migration-store";
import { makeMemoryFilesSDK } from "@migrate-sdk/files-sdk/testing";
import { MigrationStore } from "migrate-sdk";
import { DocumentParsers } from "migrate-sdk/sources/document";
const backend = makeMemoryFilesSDK();
assert.ok(FilesSDKObject && FilesSDKSource.objects && FilesSDKDocumentFetchers.text && FilesSDKDestination.make);
assert.ok(FilesSDKDocumentFetchers.texts && DocumentParsers.each);
const store = FilesSDKMigrationStore.layerFromClient({ client: backend.client, storageId: "state", namespace: "smoke", locking: "advisory" });
const runId = await Effect.runPromise(MigrationStore.use((s) => s.createRunId).pipe(Effect.provide(store)));
assert.ok(runId.startsWith("run-"));
assert.throws(() => import.meta.resolve("@migrate-sdk/files-sdk/internal/files"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
`
  );
  run(process.execPath, ["smoke.mjs"], consumer);
  await writeFile(
    join(consumer, "smoke.ts"),
    `
import { FilesSDKSource, FilesSDKDocumentFetchers } from "@migrate-sdk/files-sdk/source";
import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { FilesSDKMigrationStore } from "@migrate-sdk/files-sdk/migration-store";
import { makeMemoryFilesSDK } from "@migrate-sdk/files-sdk/testing";
const backend = makeMemoryFilesSDK();
const source = FilesSDKSource.objects({storageId: "source"}).provide(backend.layer);
const documents = FilesSDKDocumentFetchers.texts({storageId: "source", prefix: "input/", filesLayer: backend.layer});
const destination = FilesSDKDestination.make({storageId: "dest"}).provide(backend.layer);
const store = FilesSDKMigrationStore.layerFromClient({client: backend.client, storageId: "state", namespace: "smoke", locking: "advisory"});
void [source, documents, destination, store];
`
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["smoke.ts"],
    })
  );
  run(
    process.execPath,
    [
      resolve(packageDirectory, "node_modules/@typescript/native/bin/tsc"),
      "--project",
      join(consumer, "tsconfig.json"),
    ],
    consumer
  );
  console.log("Packed Files SDK exports, runtime, and declarations passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
