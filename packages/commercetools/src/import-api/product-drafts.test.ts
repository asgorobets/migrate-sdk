import type {
  ErrorObject,
  ImportOperation,
  ProductDraftImport,
  ProductDraftImportRequest,
} from "@commercetools/importapi-sdk";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type DestinationJournal,
  DestinationJournalExtensionId,
  toMigrationRunId,
} from "migrate-sdk";
import {
  makeScriptedCommercetoolsImportSdk,
  type ScriptedCommercetoolsImportSdkRequest,
  scriptedCommercetoolsImportSdkRoute,
} from "../testing/import-sdk.ts";
import {
  CommercetoolsImportContractError,
  CommercetoolsImportOperationError,
  CommercetoolsProductDraftImports,
} from "./product-drafts.ts";

const containerKey = "catalog-products";
const productDraftImportOperationExtensionId =
  DestinationJournalExtensionId.make(
    "commercetools.product-draft.import-operation@v1"
  );

const productDraft = (index: number): ProductDraftImport => {
  const key = `product-${String(index).padStart(2, "0")}`;

  return {
    key,
    name: { en: `Product ${index}` },
    productType: {
      key: "book",
      typeId: "product-type",
    },
    slug: { en: key },
  };
};

const importedOperation = (input: {
  readonly operationId: string;
  readonly resourceKey: string;
  readonly resourceVersion: number;
}): ImportOperation => ({
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-03T00:00:00.000Z",
  id: input.operationId,
  importContainerKey: containerKey,
  lastModifiedAt: "2026-09-01T00:00:01.000Z",
  resourceKey: input.resourceKey,
  resourceVersion: input.resourceVersion,
  state: "imported",
  version: 1,
});

const requestBody = (
  request: ScriptedCommercetoolsImportSdkRequest
): ProductDraftImportRequest => request.body as ProductDraftImportRequest;

describe("CommercetoolsProductDraftImports", () => {
  it.effect(
    "chunks submissions at 20 and correlates reversed operation responses by resource key",
    () => {
      const operations = new Map<string, ImportOperation>();
      let nextOperation = 0;
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("productDrafts.import").replyWith(
            (request) => {
              const resources = requestBody(request).resources;
              const operationStatus = resources.map((resource) => {
                const operationId = `operation-${nextOperation}`;
                nextOperation += 1;
                operations.set(
                  operationId,
                  importedOperation({
                    operationId,
                    resourceKey: resource.key,
                    resourceVersion: nextOperation,
                  })
                );

                return {
                  operationId,
                  state: "processing" as const,
                };
              });

              return {
                operationStatus: [...operationStatus].reverse(),
              };
            }
          ),
          scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
            (request) => {
              const operationId = String(request.pathVariables?.id);
              const operation = operations.get(operationId);

              if (operation === undefined) {
                throw new Error(`Unknown operation: ${operationId}`);
              }

              return operation;
            }
          ),
        ],
      });
      const imports = CommercetoolsProductDraftImports.provide(scripted.layer);
      const resources = Array.from({ length: 21 }, (_, index) =>
        productDraft(index + 1)
      );

      return Effect.gen(function* () {
        const outcomes = yield* imports.submitAndAwait({
          containerKey,
          resources,
        });
        const submissions = scripted.requests.filter(
          (request) => request.operation === "productDrafts.import"
        );
        const polls = scripted.requests.filter(
          (request) => request.operation === "importOperations.get"
        );

        expect(submissions).toHaveLength(2);
        expect(
          submissions.map((request) => requestBody(request).resources.length)
        ).toEqual([20, 1]);
        expect(polls).toHaveLength(21);
        expect(outcomes.size).toBe(21);

        for (const resource of resources) {
          expect(outcomes.get(resource.key)).toMatchObject({
            kind: "imported",
            resourceKey: resource.key,
            state: "imported",
          });
        }
      });
    }
  );

  it.live("submits disjoint provider chunks with bounded concurrency", () => {
    const operations = new Map<string, ImportOperation>();
    const submittedResourceKeys: string[][] = [];
    let activeSubmissions = 0;
    let maxActiveSubmissions = 0;
    let nextOperation = 1;
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").replyWith(
          async (request) => {
            const resources = requestBody(request).resources;
            activeSubmissions += 1;
            maxActiveSubmissions = Math.max(
              maxActiveSubmissions,
              activeSubmissions
            );
            submittedResourceKeys.push(
              resources.map((resource) => resource.key)
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
            activeSubmissions -= 1;

            return {
              operationStatus: resources.map((resource) => {
                const operationId = `operation-concurrent-${nextOperation}`;
                operations.set(
                  operationId,
                  importedOperation({
                    operationId,
                    resourceKey: resource.key,
                    resourceVersion: nextOperation,
                  })
                );
                nextOperation += 1;
                return { operationId, state: "processing" as const };
              }),
            };
          }
        ),
        scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
          (request) => {
            const operation = operations.get(String(request.pathVariables?.id));
            if (operation === undefined) {
              throw new Error("Missing scripted operation");
            }
            return operation;
          }
        ),
      ],
    });
    const resources = Array.from({ length: 41 }, (_, index) =>
      productDraft(index + 1)
    );

    return Effect.gen(function* () {
      const outcomes = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        resources,
        submissionConcurrency: 2,
      }).pipe(Effect.provide(scripted.layer));

      expect(maxActiveSubmissions).toBe(2);
      expect(submittedResourceKeys.map((keys) => keys.length)).toEqual([
        20, 20, 1,
      ]);
      expect(new Set(submittedResourceKeys.flat()).size).toBe(41);
      expect(outcomes.size).toBe(41);
    });
  });

  it.effect(
    "returns mixed terminal and pending outcomes and exposes settlement descriptors",
    () => {
      const issue: ErrorObject = {
        code: "Generic",
        message: "One imported action failed",
      };
      const operations = new Map<string, ImportOperation>([
        [
          "operation-imported",
          importedOperation({
            operationId: "operation-imported",
            resourceKey: "product-01",
            resourceVersion: 4,
          }),
        ],
        [
          "operation-partial",
          {
            createdAt: "2026-09-01T00:00:00.000Z",
            errors: [issue],
            expiresAt: "2026-09-03T00:00:00.000Z",
            id: "operation-partial",
            importContainerKey: containerKey,
            lastModifiedAt: "2026-09-01T00:00:01.000Z",
            resourceKey: "product-02",
            resourceVersion: 2,
            state: "partiallyImported",
            version: 1,
          },
        ],
        [
          "operation-unresolved",
          {
            createdAt: "2026-09-01T00:00:00.000Z",
            expiresAt: "2026-09-03T00:00:00.000Z",
            id: "operation-unresolved",
            importContainerKey: containerKey,
            lastModifiedAt: "2026-09-01T00:00:01.000Z",
            resourceKey: "product-03",
            state: "unresolved",
            unresolvedReferences: [
              { key: "missing-type", typeId: "product-type" },
            ],
            version: 1,
          },
        ],
      ]);
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
            operationStatus: [...operations.keys()].map((operationId) => ({
              operationId,
              state: "processing",
            })),
          }),
          scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
            (request) => {
              const operationId = String(request.pathVariables?.id);
              const operation = operations.get(operationId);

              if (operation === undefined) {
                throw new Error(`Unknown operation: ${operationId}`);
              }

              return operation;
            }
          ),
        ],
      });

      return Effect.gen(function* () {
        const outcomes = yield* CommercetoolsProductDraftImports.submitAndAwait(
          {
            containerKey,
            pollTimeout: 0,
            resources: [productDraft(1), productDraft(2), productDraft(3)],
          }
        ).pipe(Effect.provide(scripted.layer));
        const imported = outcomes.get("product-01");
        const partial = outcomes.get("product-02");
        const unresolved = outcomes.get("product-03");

        expect(imported).toMatchObject({
          kind: "imported",
          resourceVersion: 4,
        });
        expect(partial).toMatchObject({
          kind: "failed",
          resourceVersion: 2,
          state: "partiallyImported",
        });
        expect(unresolved).toMatchObject({
          kind: "pending",
          state: "unresolved",
        });

        if (partial === undefined || partial.kind !== "failed") {
          throw new Error("Expected the partial outcome");
        }

        const error =
          CommercetoolsProductDraftImports.toOperationError(partial);
        expect(error).toBeInstanceOf(CommercetoolsImportOperationError);
        expect(error).toMatchObject({
          issues: [{ code: "Generic" }],
          outcomeKind: "failed",
          resourceKey: "product-02",
          state: "partiallyImported",
        });

        const decodedImported =
          yield* CommercetoolsProductDraftImports.changes.imported.decode({
            descriptorId: CommercetoolsProductDraftImports.changes.imported.id,
            kind: "change",
            sequence: 0,
            value: {
              containerKey,
              operationId: "operation-imported",
              resourceKey: "product-01",
              resourceType: "product-draft",
              resourceVersion: 4,
              state: "imported",
            },
          });
        expect(decodedImported.value.resourceKey).toBe("product-01");
      });
    }
  );

  it.effect(
    "fails before polling when the submit response has no operation id",
    () => {
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
            operationStatus: [
              {
                errors: [{ code: "Generic", message: "Invalid draft" }],
                state: "validationFailed",
              },
            ],
          }),
        ],
      });

      return Effect.gen(function* () {
        const error = yield* CommercetoolsProductDraftImports.submitAndAwait({
          containerKey,
          resources: [productDraft(1)],
        }).pipe(Effect.provide(scripted.layer), Effect.flip);

        expect(error).toBeInstanceOf(CommercetoolsImportContractError);
        expect(error.message).toContain("operation id is missing");
        expect(scripted.requests).toHaveLength(1);
      });
    }
  );

  it.effect("rejects a foreign resource key returned by polling", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
          operationStatus: [
            { operationId: "operation-foreign", state: "processing" },
          ],
        }),
        scriptedCommercetoolsImportSdkRoute("importOperations.get").reply(
          importedOperation({
            operationId: "operation-foreign",
            resourceKey: "foreign-product",
            resourceVersion: 1,
          })
        ),
      ],
    });

    return Effect.gen(function* () {
      const error = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        resources: [productDraft(1)],
      }).pipe(Effect.provide(scripted.layer), Effect.flip);

      expect(error).toBeInstanceOf(CommercetoolsImportContractError);
      expect(error.message).toContain("unknown resource key");
    });
  });

  it.effect("rejects a mismatched operation id returned by polling", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
          operationStatus: [
            { operationId: "operation-requested", state: "processing" },
          ],
        }),
        scriptedCommercetoolsImportSdkRoute("importOperations.get").reply(
          importedOperation({
            operationId: "operation-returned",
            resourceKey: "product-01",
            resourceVersion: 1,
          })
        ),
      ],
    });

    return Effect.gen(function* () {
      const error = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        resources: [productDraft(1)],
      }).pipe(Effect.provide(scripted.layer), Effect.flip);

      expect(error).toBeInstanceOf(CommercetoolsImportContractError);

      if (!(error instanceof CommercetoolsImportContractError)) {
        throw new Error("Expected a Commercetools Import contract error");
      }

      expect(error.message).toContain("did not match the requested id");
      expect(error.details).toMatchObject({
        actualOperationId: "operation-returned",
        requestedOperationId: "operation-requested",
      });
    });
  });

  it.effect("rejects duplicate operation ids returned by submission", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
          operationStatus: [
            { operationId: "operation-duplicate", state: "processing" },
            { operationId: "operation-duplicate", state: "processing" },
          ],
        }),
      ],
    });

    return Effect.gen(function* () {
      const error = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        resources: [productDraft(1), productDraft(2)],
      }).pipe(Effect.provide(scripted.layer), Effect.flip);

      expect(error).toBeInstanceOf(CommercetoolsImportContractError);
      expect(error.message).toContain("duplicate operation id");
      expect(scripted.requests).toHaveLength(1);
    });
  });

  it.effect("rejects duplicate resource keys returned by polling", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
          operationStatus: [
            { operationId: "operation-1", state: "processing" },
            { operationId: "operation-2", state: "processing" },
          ],
        }),
        scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
          (request) => {
            const operationId = String(request.pathVariables?.id);

            return importedOperation({
              operationId,
              resourceKey: "product-01",
              resourceVersion: 1,
            });
          }
        ),
      ],
    });

    return Effect.gen(function* () {
      const error = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        resources: [productDraft(1), productDraft(2)],
      }).pipe(Effect.provide(scripted.layer), Effect.flip);

      expect(error).toBeInstanceOf(CommercetoolsImportContractError);
      expect(error.message).toContain(
        "Multiple Commercetools Import Operations"
      );
    });
  });

  it.effect("settles ambiguous submission failures per resource", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").fail(
          new Error("Import API unavailable")
        ),
      ],
    });

    return Effect.gen(function* () {
      const outcomes = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        resources: [productDraft(1)],
      }).pipe(Effect.provide(scripted.layer));
      const outcome = outcomes.get("product-01");

      expect(outcome).toMatchObject({
        acceptance: "unknown",
        candidateOperationIds: [],
        kind: "indeterminate",
        resourceKey: "product-01",
        state: "submissionFailed",
      });
      if (outcome === undefined || outcome.kind !== "indeterminate") {
        throw new Error("Expected an indeterminate submission outcome");
      }
      expect(
        CommercetoolsProductDraftImports.toOperationError(outcome)
      ).toMatchObject({
        acceptance: "unknown",
        outcomeKind: "indeterminate",
      });
    });
  });

  it.effect(
    "keeps successful concurrent chunks when a sibling submission fails",
    () => {
      const submissions: string[][] = [];
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("productDrafts.import").replyWith(
            (request) => {
              const resources = requestBody(request).resources;
              submissions.push(resources.map((resource) => resource.key));

              if (resources.some((resource) => resource.key === "product-01")) {
                throw new Error("First provider chunk was unavailable");
              }

              return {
                operationStatus: resources.map(() => ({
                  operationId: "operation-product-21",
                  state: "processing" as const,
                })),
              };
            }
          ),
          scriptedCommercetoolsImportSdkRoute("importOperations.get").reply(
            importedOperation({
              operationId: "operation-product-21",
              resourceKey: "product-21",
              resourceVersion: 1,
            })
          ),
        ],
      });
      const resources = Array.from({ length: 21 }, (_, index) =>
        productDraft(index + 1)
      );

      return Effect.gen(function* () {
        const outcomes = yield* CommercetoolsProductDraftImports.submitAndAwait(
          {
            containerKey,
            resources,
            submissionConcurrency: 2,
          }
        ).pipe(Effect.provide(scripted.layer));

        expect(submissions.map((keys) => keys.length)).toEqual([20, 1]);
        expect(outcomes.get("product-01")).toMatchObject({
          acceptance: "unknown",
          candidateResourceKeys: resources
            .slice(0, 20)
            .map((resource) => resource.key),
          kind: "indeterminate",
          state: "submissionFailed",
        });
        expect(outcomes.get("product-21")).toMatchObject({
          kind: "imported",
          resourceKey: "product-21",
        });
      });
    }
  );

  it.effect("keeps terminal siblings when another operation poll fails", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
          operationStatus: [
            { operationId: "operation-imported", state: "processing" },
            { operationId: "operation-unavailable", state: "processing" },
          ],
        }),
        scriptedCommercetoolsImportSdkRoute("importOperations.get")
          .matchPath({ id: "operation-imported" })
          .reply(
            importedOperation({
              operationId: "operation-imported",
              resourceKey: "product-01",
              resourceVersion: 7,
            })
          ),
        scriptedCommercetoolsImportSdkRoute("importOperations.get")
          .matchPath({ id: "operation-unavailable" })
          .fail(new Error("Status endpoint unavailable")),
      ],
    });

    return Effect.gen(function* () {
      const outcomes = yield* CommercetoolsProductDraftImports.submitAndAwait({
        containerKey,
        pollTimeout: 0,
        resources: [productDraft(1), productDraft(2)],
      }).pipe(Effect.provide(scripted.layer));

      expect(outcomes.get("product-01")).toMatchObject({
        kind: "imported",
        resourceVersion: 7,
      });
      expect(outcomes.get("product-02")).toMatchObject({
        acceptance: "accepted",
        candidateOperationIds: ["operation-unavailable"],
        kind: "indeterminate",
        state: "pollFailed",
      });
    });
  });

  it.effect(
    "re-polls shared candidate operation ids after a multi-operation polling outage",
    () => {
      const operationIds = ["operation-1", "operation-2"] as const;
      const unavailable = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("productDrafts.import").reply({
            operationStatus: operationIds.map((operationId) => ({
              operationId,
              state: "processing" as const,
            })),
          }),
          scriptedCommercetoolsImportSdkRoute("importOperations.get").fail(
            new Error("Status endpoint unavailable")
          ),
        ],
      });
      const recovered = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
            (request) => {
              const operationId = String(request.pathVariables?.id);
              const resourceKey =
                operationId === "operation-1" ? "product-01" : "product-02";

              return importedOperation({
                operationId,
                resourceKey,
                resourceVersion: 1,
              });
            }
          ),
        ],
      });

      return Effect.gen(function* () {
        const first = yield* CommercetoolsProductDraftImports.submitAndAwait({
          containerKey,
          pollTimeout: 0,
          resources: [productDraft(1), productDraft(2)],
        }).pipe(Effect.provide(unavailable.layer));

        for (const resourceKey of ["product-01", "product-02"]) {
          expect(first.get(resourceKey)).toMatchObject({
            acceptance: "accepted",
            candidateOperationIds: operationIds,
            kind: "indeterminate",
            state: "pollFailed",
          });
        }

        const runId = toMigrationRunId("run-1");
        const candidates = yield* Effect.forEach(
          ["product-01", "product-02"],
          (resourceKey) => {
            const outcome = first.get(resourceKey);
            if (outcome === undefined || outcome.kind !== "indeterminate") {
              return Effect.die("Expected an indeterminate import outcome");
            }
            const journal: DestinationJournal = {
              extensions: {
                [productDraftImportOperationExtensionId]: {
                  acceptance: outcome.acceptance,
                  candidateOperationIds: [...outcome.candidateOperationIds],
                  candidateResourceKeys: ["product-01", "product-02"],
                  containerKey: outcome.containerKey,
                  message: outcome.message,
                  resourceKey,
                  resourceType: "product-draft",
                  state: outcome.state,
                },
              },
              process: {
                entries: [],
                runId,
              },
              rollbackAttempts: [],
            };

            return CommercetoolsProductDraftImports.resumeFromJournal(
              journal,
              resourceKey
            );
          }
        );

        expect(candidates).toEqual([
          {
            candidateOperationIds: operationIds,
            candidateResourceKeys: ["product-01", "product-02"],
            kind: "await",
            resourceKey: "product-01",
          },
          {
            candidateOperationIds: operationIds,
            candidateResourceKeys: ["product-01", "product-02"],
            kind: "await",
            resourceKey: "product-02",
          },
        ]);

        const outcomes =
          yield* CommercetoolsProductDraftImports.awaitOperations({
            candidates: candidates.flatMap((candidate) =>
              candidate.kind === "await" ? [candidate] : []
            ),
            containerKey,
          }).pipe(Effect.provide(recovered.layer));

        expect(outcomes.get("product-01")?.kind).toBe("imported");
        expect(outcomes.get("product-02")?.kind).toBe("imported");
        expect(recovered.requests.map((request) => request.operation)).toEqual([
          "importOperations.get",
          "importOperations.get",
        ]);

        const targeted =
          yield* CommercetoolsProductDraftImports.awaitOperations({
            candidates: candidates
              .slice(0, 1)
              .flatMap((candidate) =>
                candidate.kind === "await" ? [candidate] : []
              ),
            containerKey,
          }).pipe(Effect.provide(recovered.layer));

        expect([...targeted.keys()]).toEqual(["product-01"]);
        expect(targeted.get("product-01")?.kind).toBe("imported");
        expect(recovered.requests.map((request) => request.operation)).toEqual([
          "importOperations.get",
          "importOperations.get",
          "importOperations.get",
          "importOperations.get",
        ]);
      });
    }
  );

  it.effect("resumes persisted receipts without submitting again", () => {
    const scripted = makeScriptedCommercetoolsImportSdk({
      projectKey: "example-project",
      routes: [
        scriptedCommercetoolsImportSdkRoute("importOperations.get").reply(
          importedOperation({
            operationId: "operation-persisted",
            resourceKey: "product-01",
            resourceVersion: 9,
          })
        ),
      ],
    });

    return Effect.gen(function* () {
      const outcomes = yield* CommercetoolsProductDraftImports.awaitOperations({
        containerKey,
        candidates: [
          {
            candidateOperationIds: ["operation-persisted"],
            resourceKey: "product-01",
          },
        ],
      }).pipe(Effect.provide(scripted.layer));

      expect(outcomes.get("product-01")).toMatchObject({
        kind: "imported",
        operationId: "operation-persisted",
      });
      expect(scripted.requests.map((request) => request.operation)).toEqual([
        "importOperations.get",
      ]);
    });
  });

  it.effect(
    "rejects operation correlation across separate persisted candidate groups",
    () => {
      const resourcesByOperationId = new Map([
        ["operation-1", "product-03"],
        ["operation-2", "product-02"],
        ["operation-3", "product-03"],
        ["operation-4", "product-04"],
      ]);
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
            (request) => {
              const operationId = String(request.pathVariables?.id);
              const resourceKey = resourcesByOperationId.get(operationId);
              if (resourceKey === undefined) {
                throw new Error(`Unknown operation: ${operationId}`);
              }

              return importedOperation({
                operationId,
                resourceKey,
                resourceVersion: 1,
              });
            }
          ),
        ],
      });

      return Effect.gen(function* () {
        const error = yield* CommercetoolsProductDraftImports.awaitOperations({
          candidates: [
            {
              candidateOperationIds: ["operation-1", "operation-2"],
              resourceKey: "product-01",
            },
            {
              candidateOperationIds: ["operation-1", "operation-2"],
              resourceKey: "product-02",
            },
            {
              candidateOperationIds: ["operation-3", "operation-4"],
              resourceKey: "product-03",
            },
            {
              candidateOperationIds: ["operation-3", "operation-4"],
              resourceKey: "product-04",
            },
          ],
          containerKey,
        }).pipe(Effect.provide(scripted.layer), Effect.flip);

        expect(error).toBeInstanceOf(CommercetoolsImportContractError);
        expect(error).toMatchObject({
          details: {
            actualResourceKey: "product-03",
            candidateResourceKeys: ["product-01", "product-02"],
            operationId: "operation-1",
          },
        });
      });
    }
  );

  it.effect(
    "chunks by encoded request-body bytes as well as resource count",
    () => {
      const operations = new Map<string, ImportOperation>();
      let nextOperation = 1;
      const scripted = makeScriptedCommercetoolsImportSdk({
        projectKey: "example-project",
        routes: [
          scriptedCommercetoolsImportSdkRoute("productDrafts.import").replyWith(
            (request) => ({
              operationStatus: requestBody(request).resources.map(
                (resource) => {
                  const operationId = `operation-size-${nextOperation}`;
                  operations.set(
                    operationId,
                    importedOperation({
                      operationId,
                      resourceKey: resource.key,
                      resourceVersion: nextOperation,
                    })
                  );
                  nextOperation += 1;

                  return { operationId, state: "processing" as const };
                }
              ),
            })
          ),
          scriptedCommercetoolsImportSdkRoute("importOperations.get").replyWith(
            (request) => {
              const operation = operations.get(
                String(request.pathVariables?.id)
              );
              if (operation === undefined) {
                throw new Error("Missing scripted operation");
              }
              return operation;
            }
          ),
        ],
      });
      const resources = [productDraft(1), productDraft(2)];
      const oneResourceBytes = new TextEncoder().encode(
        JSON.stringify({ resources: [resources[0]], type: "product-draft" })
      ).byteLength;

      return Effect.gen(function* () {
        const outcomes = yield* CommercetoolsProductDraftImports.submitAndAwait(
          {
            containerKey,
            maxRequestBodyBytes: oneResourceBytes,
            resources,
          }
        ).pipe(Effect.provide(scripted.layer));
        const submissions = scripted.requests.filter(
          (request) => request.operation === "productDrafts.import"
        );

        expect(submissions).toHaveLength(2);
        expect(
          submissions.map((request) => requestBody(request).resources.length)
        ).toEqual([1, 1]);
        expect(outcomes.size).toBe(2);
      });
    }
  );
});
