import type { ProductDraftImport } from "@commercetools/importapi-sdk";
import {
  type CommercetoolsImportContainerContractError,
  CommercetoolsImportContainers,
  CommercetoolsImportContractError,
  type CommercetoolsImportOperationError,
  type CommercetoolsImportSdkError,
  type CommercetoolsImportSdkLayer,
  type CommercetoolsProductDraftImportFailedOutcome,
  type CommercetoolsProductDraftImportOutcome,
  CommercetoolsProductDraftImports,
} from "@migrate-sdk/commercetools/import-api";
import {
  type Duration,
  Effect,
  type Layer as EffectLayer,
  Schema,
} from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  type MigrationStore,
  type MigrationStoreError,
  type ProcessBatchContractError,
  type ProcessBatchItem,
  type ProcessBatchPipelineFor,
  type ProcessBatchSettlement,
  SourceIdentity,
  type SourceIdentitySnapshotKey,
  type SourceItemInput,
  Tracking,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";

export const catalogProductImportDefinitionId = "product-import-batch";
export const catalogProductImportContainerKey =
  "migrate-sdk-product-import-batch";

export const CatalogProductImportSource = Schema.Struct({
  format: Schema.Literals(["hardcover", "paperback"]),
  isbn: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  pages: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  productTypeKey: Schema.NonEmptyString,
  sku: Schema.NonEmptyString,
  slug: Schema.NonEmptyString,
});
export type CatalogProductImportSource = typeof CatalogProductImportSource.Type;

export const CatalogProductImportSourceIdentity = SourceIdentity.make({
  id: "commercetools-product-import@v1",
  schema: SourceIdentity.key("key", Schema.NonEmptyString),
});

export const CatalogProductImportTracking = Tracking.record({
  id: "commercetools-product-import-tracking@v1",
  schema: Schema.Struct({
    productKey: Schema.NonEmptyString,
    productVersion: Schema.Int,
  }),
});

export type CatalogProductImportProcessError =
  | CommercetoolsImportContractError
  | CommercetoolsImportContainerContractError
  | CommercetoolsImportOperationError
  | CommercetoolsImportSdkError
  | ProcessBatchContractError
  | Schema.SchemaError;

const productNumber = (index: number): string =>
  String(index + 1).padStart(2, "0");

export const catalogProductImportItems: readonly SourceItemInput<CatalogProductImportSource>[] =
  Array.from({ length: 25 }, (_, index) => {
    const number = productNumber(index);
    const key = `catalog-product-${number}`;

    return {
      identityKey: key,
      item: {
        format: index % 2 === 0 ? "paperback" : "hardcover",
        isbn: `97800000000${number}`,
        key,
        name: `Catalog Product ${number}`,
        pages: 100 + index,
        productTypeKey: "book",
        sku: `${key}-sku`,
        slug: key,
      },
      version: "source-version-1",
    };
  });

export const toProductDraftImport = (
  source: CatalogProductImportSource
): ProductDraftImport => ({
  key: source.key,
  masterVariant: {
    attributes: [
      { name: "format", type: "text", value: source.format },
      { name: "isbn", type: "text", value: source.isbn },
      { name: "pages", type: "number", value: source.pages },
    ],
    key: `${source.key}-master`,
    sku: source.sku,
  },
  name: { "en-US": source.name },
  productType: {
    key: source.productTypeKey,
    typeId: "product-type",
  },
  publish: false,
  slug: { "en-US": source.slug },
});

type CatalogProductImportBatchItem = ProcessBatchItem<
  CatalogProductImportSource,
  CatalogProductImportProcessError,
  SourceIdentitySnapshotKey,
  typeof CatalogProductImportTracking
>;

const importedChange = (
  outcome: Extract<
    CommercetoolsProductDraftImportOutcome,
    { readonly kind: "imported" }
  >
) => ({
  containerKey: outcome.containerKey,
  operationId: outcome.operationId,
  resourceKey: outcome.resourceKey,
  resourceType: "product-draft" as const,
  resourceVersion: outcome.resourceVersion,
  state: "imported" as const,
});

const partiallyImportedChange = (
  outcome: CommercetoolsProductDraftImportFailedOutcome
) => ({
  containerKey: outcome.containerKey,
  issues: outcome.errors.map(({ code, message }) => ({ code, message })),
  operationId: outcome.operationId,
  resourceKey: outcome.resourceKey,
  resourceType: "product-draft" as const,
  resourceVersion: outcome.resourceVersion ?? null,
  state: "partiallyImported" as const,
});

const settleProductImportOutcome = (
  item: CatalogProductImportBatchItem,
  outcome: CommercetoolsProductDraftImportOutcome
): ProcessBatchSettlement =>
  item.settle(
    Effect.gen(function* () {
      yield* CommercetoolsProductDraftImports.recordOperationOutcome(outcome);

      if (outcome.kind === "imported") {
        yield* Tracking.recordChange(
          CommercetoolsProductDraftImports.changes.imported,
          importedChange(outcome)
        );
        yield* Tracking.setRecord({
          productKey: outcome.resourceKey,
          productVersion: outcome.resourceVersion,
        });
        return;
      }

      if (outcome.kind === "failed" && outcome.state === "partiallyImported") {
        yield* Tracking.recordChange(
          CommercetoolsProductDraftImports.changes.partiallyImported,
          partiallyImportedChange(outcome)
        );
      }

      return yield* CommercetoolsProductDraftImports.toOperationError(outcome);
    })
  );

export interface CatalogProductImportMigrationOptions {
  readonly containerKey?: string;
  readonly importSdkLayer: CommercetoolsImportSdkLayer;
  readonly items?: readonly SourceItemInput<CatalogProductImportSource>[];
  readonly pollInterval?: Duration.Input;
  readonly pollTimeout?: Duration.Input;
  readonly sourceBatchSize?: number;
  readonly storeLayer: EffectLayer.Layer<MigrationStore, MigrationStoreError>;
  readonly submissionConcurrency?: number;
  readonly toProductDraftImport?: (
    source: CatalogProductImportSource
  ) => ProductDraftImport;
}

export const makeCatalogProductImportMigration = (
  options: CatalogProductImportMigrationOptions
) => {
  const containerKey = options.containerKey ?? catalogProductImportContainerKey;
  const imports = CommercetoolsProductDraftImports.provide(
    options.importSdkLayer
  );
  const makeProductDraftImport =
    options.toProductDraftImport ?? toProductDraftImport;
  const source = InMemorySource.make({
    batchSize: options.sourceBatchSize ?? 21,
    identity: CatalogProductImportSourceIdentity,
    items: options.items ?? catalogProductImportItems,
    sourceSchema: CatalogProductImportSource,
  });

  type CatalogProductImportBatchPipeline = ProcessBatchPipelineFor<
    typeof source,
    CatalogProductImportProcessError,
    typeof CatalogProductImportTracking
  >;
  type CatalogProductImportBatchItems =
    Parameters<CatalogProductImportBatchPipeline>[0];

  const processBatch: CatalogProductImportBatchPipeline = Effect.fn(
    "catalogProducts.processBatch"
  )(function* (items: CatalogProductImportBatchItems) {
    const prepared = yield* Effect.forEach(items, (item) => {
      const draft = makeProductDraftImport(item.source.item);

      return imports
        .resumeFromJournal(item.context.previousState?.journal, draft.key)
        .pipe(
          Effect.match({
            onFailure: (error) => ({
              kind: "failed" as const,
              settlement: item.settle(Effect.fail(error)),
            }),
            onSuccess: (resume) => ({
              draft,
              item,
              kind: "ready" as const,
              resume,
            }),
          })
        );
    });
    const pairs = prepared.flatMap((entry) =>
      entry.kind === "ready" ? [entry] : []
    );
    const outcomes = new Map<string, CommercetoolsProductDraftImportOutcome>();
    const awaiting = pairs.flatMap(({ draft, resume }) =>
      resume.kind === "await"
        ? [
            {
              candidate: {
                candidateOperationIds: resume.candidateOperationIds,
                candidateResourceKeys: resume.candidateResourceKeys,
                resourceKey: resume.resourceKey,
              },
              draft,
            },
          ]
        : []
    );
    const fresh = pairs.flatMap(({ draft, resume }) =>
      resume.kind === "submit" ? [draft] : []
    );

    for (const { draft, resume } of pairs) {
      if (resume.kind === "blocked") {
        outcomes.set(draft.key, resume.outcome);
      }
    }

    if (awaiting.length > 0) {
      const resumed = yield* imports
        .awaitOperations({
          containerKey,
          ...(options.pollInterval === undefined
            ? {}
            : { pollInterval: options.pollInterval }),
          pollTimeout: options.pollTimeout ?? "30 seconds",
          candidates: awaiting.map(({ candidate }) => candidate),
        })
        .pipe(Effect.mapError(imports.toProcessBatchContractError));
      for (const [resourceKey, outcome] of resumed) {
        outcomes.set(resourceKey, outcome);
      }
    }

    if (fresh.length > 0) {
      const submitted = yield* imports
        .submitAndAwait({
          containerKey,
          ...(options.pollInterval === undefined
            ? {}
            : { pollInterval: options.pollInterval }),
          pollTimeout: options.pollTimeout ?? "30 seconds",
          resources: fresh,
          ...(options.submissionConcurrency === undefined
            ? {}
            : { submissionConcurrency: options.submissionConcurrency }),
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof CommercetoolsImportContractError
              ? imports.toProcessBatchContractError(error)
              : error
          )
        );
      for (const [resourceKey, outcome] of submitted) {
        outcomes.set(resourceKey, outcome);
      }
    }

    return prepared.map((entry) => {
      if (entry.kind === "failed") {
        return entry.settlement;
      }

      const { draft, item } = entry;
      const outcome = outcomes.get(draft.key);

      if (outcome === undefined) {
        throw new Error(`Missing validated import outcome for ${draft.key}`);
      }

      return settleProductImportOutcome(item, outcome);
    });
  });

  return MigrationDefinition.make({
    id: catalogProductImportDefinitionId,
    processBatch,
    source,
    store: options.storeLayer,
    tracking: CatalogProductImportTracking,
  });
};

export const runCatalogProductImportMigration = Effect.fn(
  "runCatalogProductImportMigration"
)(function* (options: CatalogProductImportMigrationOptions) {
  const containerKey = options.containerKey ?? catalogProductImportContainerKey;

  yield* CommercetoolsImportContainers.ensure({
    key: containerKey,
    resourceType: "product-draft",
    retentionPolicy: {
      config: { timeToLive: "30d" },
      strategy: "ttl",
    },
  }).pipe(Effect.provide(options.importSdkLayer));

  const definition = makeCatalogProductImportMigration(options);
  const registry = MigrationDefinitionRegistry.make({
    definitions: [definition] as const,
  });
  const execution = MigrationExecution.make({ registry });
  const started = yield* execution.run({ all: true });

  if (started.kind === "completed") {
    return started.summary;
  }
  if (started.handle === undefined) {
    return yield* Effect.die("Inline example execution detached unexpectedly");
  }

  const result = yield* started.handle.wait;

  if (result.kind === "finished") {
    return result.summary;
  }
  if (result.kind === "execution-failed") {
    return yield* Effect.fail(result.cause);
  }

  return yield* Effect.die("Inline example execution was cancelled");
});
