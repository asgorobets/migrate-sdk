import { randomUUID } from "node:crypto";
import { DateTime, Effect, Layer, Semaphore } from "effect";
import type { Files as FilesSDKClient } from "files-sdk";
import { Files, make } from "files-sdk/effect";
import {
  canReplaceLatestMigrationDefinitionRun,
  EncodedSourceCursor,
  isActiveMigrationRunStatus,
  MigrationContractSchema,
  type MigrationDefinitionId,
  type MigrationDefinitionLock,
  type MigrationDefinitionRunOutcome,
  type MigrationExecutionHandle,
  type MigrationItemState,
  type MigrationRunId,
  type MigrationRunStartInput,
  type MigrationRunState,
  MigrationStore,
  makeMigrationDefinitionRunState,
  migrationDefinitionRunStatus,
  MigrationRunId as RunIdSchema,
  resolveMigrationRunTransition,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  validateMigrationDefinitionRunOutcomes,
  validateMigrationRunDefinitionIds,
} from "migrate-sdk";
import { PersistedMigrationItemState } from "migrate-sdk/core";
import {
  type FilesSDKMigrationStoreOptions,
  makePersistence,
  storeError,
} from "./persistence.ts";
import { Completion, Lock, Manifest, Run } from "./records.ts";

const namespacePattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const prefixPattern = /^[a-z0-9][a-z0-9/_-]*$/u;

export const filesSDKMigrationStoreDisclosure =
  "FilesSDKMigrationStore uses advisory, non-atomic locks. Run one authoritative writer per namespace, including migration execution and run-control updates. Concurrent processes can both acquire a lock, overwrite state, or delete a replacement lock. Locks do not expire. Stop the original worker before explicitly unlocking. Use a transactional store for concurrent writers.";

function layer(options: FilesSDKMigrationStoreOptions) {
  // A server can rebuild this layer for different operations. Keep the gate
  // on the shared layer reference, not on one temporary layer acquisition.
  const mutex = Semaphore.makeUnsafe(1);
  let disclosed = false;
  return Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const prefix = options.prefix ?? "migrate-sdk";
      if (
        options.locking !== "advisory" ||
        !options.storageId.trim() ||
        !namespacePattern.test(options.namespace) ||
        !prefixPattern.test(prefix) ||
        prefix.endsWith("/") ||
        prefix.includes("//") ||
        [
          options.pageSize ?? 100,
          options.readConcurrency ?? 4,
          options.maxRecordBytes ?? 16 * 1024 * 1024,
        ].some((n) => !Number.isSafeInteger(n) || n <= 0)
      ) {
        return yield* storeError(
          "invalid configuration (locking must explicitly be advisory)"
        );
      }
      const files = yield* Files;
      const persistence = makePersistence(files, options);
      const { address, read, write, remove } = persistence;
      // This mutex belongs to the shared store instance. It does not coordinate
      // other instances or processes, and deliberately makes no distributed claim.
      const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        mutex.withPermit(effect.pipe(Effect.uninterruptible));
      const manifest = address("manifest");
      yield* serialized(
        Effect.gen(function* () {
          if ((yield* read(manifest, Manifest)) === null) {
            yield* write(manifest, Manifest, {
              storeKind: "files-sdk",
              createdAt: yield* DateTime.nowAsDate,
            });
          }
        })
      );
      if (!disclosed) {
        disclosed = true;
        yield* Effect.logWarning(filesSDKMigrationStoreDisclosure);
      }

      const getItemState: typeof MigrationStore.Service.getItemState = (
        id,
        identity
      ) =>
        read(address("item", id, identity), PersistedMigrationItemState).pipe(
          Effect.flatMap((item) =>
            item !== null &&
            (item.definitionId !== id ||
              item.sourceIdentity.encoded !== identity)
              ? Effect.fail(storeError("item-state identity mismatch"))
              : Effect.succeed(item)
          )
        );
      const upsertItemState: typeof MigrationStore.Service.upsertItemState = (
        state
      ) =>
        write(
          address("item", state.definitionId, state.sourceIdentity.encoded),
          PersistedMigrationItemState,
          state
        );
      const getRunRecord = (runId: MigrationRunId) =>
        read(address("run", runId), Run).pipe(
          Effect.flatMap((run) =>
            run !== null && run.state.runId !== runId
              ? Effect.fail(storeError("run identity mismatch"))
              : Effect.succeed(run)
          )
        );
      const getLatestId = (id: MigrationDefinitionId) =>
        read(address("latest-run", id), RunIdSchema);

      const start = (
        input: MigrationRunStartInput,
        status: "queued" | "running"
      ) =>
        serialized(
          Effect.gen(function* () {
            const existing = yield* getRunRecord(input.runId);
            if (existing !== null) {
              yield* validateMigrationRunDefinitionIds(
                existing.state,
                input.definitionIds
              );
            }
            const predecessors =
              existing?.predecessors ??
              (yield* Effect.forEach(input.definitionIds, (definitionId) =>
                Effect.gen(function* () {
                  return {
                    definitionId,
                    runId: yield* getLatestId(definitionId),
                  };
                })
              ));
            const transition = resolveMigrationRunTransition(
              existing?.state.status,
              status
            );
            const state: MigrationRunState =
              existing === null
                ? {
                    ...input,
                    status,
                    startedAt: yield* DateTime.nowAsDate,
                  }
                : {
                    ...existing.state,
                    status: transition.status ?? existing.state.status,
                  };
            yield* write(address("run", input.runId), Run, {
              ...(existing ?? {}),
              state,
              predecessors,
            });
            for (const predecessor of predecessors) {
              const current = yield* getLatestId(predecessor.definitionId);
              if (
                canReplaceLatestMigrationDefinitionRun({
                  currentRunId: current,
                  predecessorRunId: predecessor.runId,
                  runId: input.runId,
                })
              ) {
                yield* write(
                  address("latest-run", predecessor.definitionId),
                  RunIdSchema,
                  input.runId
                );
              }
            }
            return state;
          })
        );

      const update = (
        runId: MigrationRunId,
        definitionIds: readonly MigrationDefinitionId[],
        input: {
          readonly status?: MigrationRunState["status"];
          readonly finish?: boolean;
          readonly cancelIfRequested?: boolean;
          readonly onlyIfActive?: boolean;
          readonly execution?: MigrationExecutionHandle;
          readonly outcomes?: readonly MigrationDefinitionRunOutcome[];
        }
      ) =>
        serialized(
          Effect.gen(function* () {
            const record = yield* getRunRecord(runId);
            if (record === null) {
              return yield* storeError("run was not found");
            }
            yield* validateMigrationRunDefinitionIds(
              record.state,
              definitionIds
            );
            if (input.outcomes !== undefined) {
              yield* validateMigrationDefinitionRunOutcomes(
                definitionIds,
                input.outcomes
              );
            }
            if (
              input.onlyIfActive === true &&
              !isActiveMigrationRunStatus(record.state.status)
            ) {
              return record.state;
            }
            const transition = resolveMigrationRunTransition(
              record.state.status,
              input.status,
              {
                cancelIfRequested: input.cancelIfRequested,
              }
            );
            if (!transition.accepted) {
              return record.state;
            }
            const state: MigrationRunState = {
              ...record.state,
              status: transition.status ?? record.state.status,
              ...(input.execution === undefined
                ? {}
                : { execution: input.execution }),
              ...(input.finish === true
                ? {
                    finishedAt:
                      record.state.finishedAt ?? (yield* DateTime.nowAsDate),
                  }
                : {}),
            };
            yield* write(address("run", runId), Run, {
              ...record,
              state,
              ...(input.outcomes === undefined
                ? {}
                : { outcomes: input.outcomes }),
            });
            return state;
          })
        );

      const getDefinitionLock: typeof MigrationStore.Service.getDefinitionLock =
        (id) =>
          read(address("lock", id), Lock).pipe(
            Effect.flatMap((lock) =>
              lock !== null && lock.definitionId !== id
                ? Effect.fail(storeError("lock definition mismatch"))
                : Effect.succeed(lock)
            )
          );
      function assertOwner(
        lock: MigrationDefinitionLock,
        current: MigrationDefinitionLock | null
      ) {
        return current !== null &&
          current.ownerRunId === lock.ownerRunId &&
          current.token === lock.token
          ? Effect.void
          : Effect.fail(
              storeError(
                "definition lock is missing or owned by another runner"
              )
            );
      }

      const service: typeof MigrationStore.Service = {
        createRunId: Effect.sync(() => toMigrationRunId(`run-${randomUUID()}`)),
        getSourceCursor: (id) =>
          read(address("cursor", id), EncodedSourceCursor),
        setSourceCursor: (id, cursor) =>
          serialized(write(address("cursor", id), EncodedSourceCursor, cursor)),
        deleteSourceCursor: (id) => serialized(remove(address("cursor", id))),
        getMigrationContract: (id) =>
          read(address("contract", id), MigrationContractSchema).pipe(
            Effect.flatMap((contract) =>
              contract !== null && contract.definitionId !== id
                ? Effect.fail(storeError("contract definition mismatch"))
                : Effect.succeed(contract)
            )
          ),
        upsertMigrationContract: (contract) =>
          serialized(
            write(
              address("contract", contract.definitionId),
              MigrationContractSchema,
              contract
            )
          ),
        getDefinitionCompletion: (id) =>
          read(address("completion", id), Completion).pipe(
            Effect.flatMap((completion) =>
              completion !== null && completion.definitionId !== id
                ? Effect.fail(storeError("completion definition mismatch"))
                : Effect.succeed(completion)
            )
          ),
        recordSourcePassCompletion: (completion) =>
          serialized(
            write(
              address("completion", completion.definitionId),
              Completion,
              completion
            )
          ),
        getItemState,
        upsertItemState: (state) => serialized(upsertItemState(state)),
        listItemStates: (id) =>
          Effect.suspend(() => {
            const states: MigrationItemState[] = [];
            return persistence
              .scanItems(
                id,
                PersistedMigrationItemState,
                (s) => s.sourceIdentity.encoded,
                (s) => {
                  states.push(s);
                }
              )
              .pipe(Effect.as(states));
          }),
        getItemStateSummary: (id) =>
          Effect.suspend(() => {
            const summary = {
              migrated: 0,
              skipped: 0,
              failed: 0,
              needsUpdate: 0,
            };
            return persistence
              .scanItems(
                id,
                PersistedMigrationItemState,
                (s) => s.sourceIdentity.encoded,
                (s) => {
                  switch (s.status) {
                    case "needs-update":
                      summary.needsUpdate++;
                      break;
                    default:
                      summary[s.status]++;
                  }
                }
              )
              .pipe(Effect.as(summary));
          }),
        observeItemState: (id, identity, runId) =>
          serialized(
            Effect.gen(function* () {
              const state = yield* getItemState(id, identity);
              if (state !== null && state.lastSourceInventoryRunId !== runId) {
                yield* upsertItemState({
                  ...state,
                  lastSourceInventoryRunId: runId,
                });
              }
            })
          ),
        listOrphanItemStates: (id, runId, page) =>
          Effect.suspend(() => {
            const limit = Math.max(0, Math.floor(page.limit));
            if (!Number.isSafeInteger(limit)) {
              return Effect.fail(storeError("invalid orphan page limit"));
            }
            if (limit === 0) {
              return Effect.succeed({ items: [] as MigrationItemState[] });
            }
            const candidates: MigrationItemState[] = [];
            return persistence
              .scanItems(
                id,
                PersistedMigrationItemState,
                (s) => s.sourceIdentity.encoded,
                (s) => {
                  if (
                    s.lastSourceInventoryRunId === runId ||
                    (page.afterIdentity !== undefined &&
                      s.sourceIdentity.encoded <= page.afterIdentity)
                  ) {
                    return;
                  }
                  candidates.push(s);
                  candidates.sort((a, b) => {
                    if (a.sourceIdentity.encoded < b.sourceIdentity.encoded) {
                      return -1;
                    }
                    if (a.sourceIdentity.encoded > b.sourceIdentity.encoded) {
                      return 1;
                    }
                    return 0;
                  });
                  if (candidates.length > limit + 1) {
                    candidates.pop();
                  }
                }
              )
              .pipe(
                Effect.map(() => {
                  const items = candidates.slice(0, limit);
                  const last = items.at(-1);
                  return {
                    items,
                    ...(candidates.length > limit && last !== undefined
                      ? { nextAfterIdentity: last.sourceIdentity.encoded }
                      : {}),
                  };
                })
              );
          }),
        removeRolledBackItem: ({ definitionId, sourceIdentity }) =>
          serialized(
            Effect.gen(function* () {
              if (
                (yield* getItemState(definitionId, sourceIdentity)) === null
              ) {
                return;
              }
              yield* remove(address("completion", definitionId));
              yield* remove(address("cursor", definitionId));
              yield* remove(address("item", definitionId, sourceIdentity));
            })
          ),
        getRunState: (id) =>
          getRunRecord(id).pipe(Effect.map((r) => r?.state ?? null)),
        getLatestRunState: (id) =>
          Effect.gen(function* () {
            const runId = yield* getLatestId(id);
            if (runId === null) {
              return null;
            }
            const run = yield* getRunRecord(runId);
            if (run === null || !run.state.definitionIds.includes(id)) {
              return yield* storeError(
                "latest-run pointer has no matching history"
              );
            }
            const outcomes =
              run.outcomes === undefined
                ? undefined
                : new Map(run.outcomes.map((o) => [o.definitionId, o.status]));
            return makeMigrationDefinitionRunState(
              id,
              run.state,
              migrationDefinitionRunStatus(id, run.state.status, outcomes)
            );
          }),
        beginRun: (input) => start(input, "running"),
        queueRun: (input) => start(input, "queued"),
        attachRunExecution: (id, definitions, execution) =>
          update(id, definitions, { execution }),
        requestRunCancellation: (id, definitions) =>
          update(id, definitions, { status: "cancelling", onlyIfActive: true }),
        markRunCancelled: (id, definitions) =>
          update(id, definitions, { status: "cancelled", finish: true }),
        markRunStartFailed: (id, definitions) =>
          update(id, definitions, { status: "start-failed", finish: true }),
        completeRun: (id, definitions, outcomes) =>
          update(id, definitions, {
            status: "succeeded",
            cancelIfRequested: true,
            finish: true,
            outcomes,
          }),
        failRun: (id, definitions, outcomes) =>
          update(id, definitions, { status: "failed", finish: true, outcomes }),
        getDefinitionLock,
        acquireDefinitionLock: (definitionId, ownerRunId) =>
          serialized(
            Effect.gen(function* () {
              if ((yield* getDefinitionLock(definitionId)) !== null) {
                return yield* storeError(
                  "migration definition is already locked"
                );
              }
              const lock: MigrationDefinitionLock = {
                definitionId,
                ownerRunId,
                token: toMigrationDefinitionLockToken(`lock-${randomUUID()}`),
                createdAt: yield* DateTime.nowAsDate,
              };
              yield* write(address("lock", definitionId), Lock, lock);
              yield* assertOwner(lock, yield* getDefinitionLock(definitionId));
              return lock;
            })
          ),
        assertDefinitionLocks: (locks) =>
          Effect.forEach(
            locks,
            (lock) =>
              getDefinitionLock(lock.definitionId).pipe(
                Effect.flatMap((current) => assertOwner(lock, current))
              ),
            { discard: true }
          ),
        releaseDefinitionLock: (lock) =>
          serialized(
            Effect.gen(function* () {
              const current = yield* getDefinitionLock(lock.definitionId);
              if (current === null) {
                return;
              }
              yield* assertOwner(lock, current);
              yield* remove(address("lock", lock.definitionId));
            })
          ),
        breakDefinitionLock: (id) =>
          serialized(
            Effect.gen(function* () {
              const lock = yield* getDefinitionLock(id);
              if (lock !== null) {
                yield* remove(address("lock", id));
              }
              return lock;
            })
          ),
      };
      return service;
    })
  );
}

function layerFromClient(
  options: FilesSDKMigrationStoreOptions & { readonly client: FilesSDKClient }
) {
  return layer(options).pipe(
    Layer.provide(Layer.succeed(Files, make(options.client)))
  );
}

export const FilesSDKMigrationStore = { layer, layerFromClient } as const;
