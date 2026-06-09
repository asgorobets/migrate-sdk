import { fileURLToPath } from "node:url";
import type { Attribute, ProductDraft } from "@commercetools/platform-sdk";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsDestinationPlugin } from "@migrate-sdk/commercetools/destination";
import {
  makeRecordingCommercetoolsApiRoot,
  type RecordedCommercetoolsRequest,
} from "@migrate-sdk/commercetools/testing";
import { Console, Effect, Schema } from "effect";
import {
  type DestinationCommandResult,
  DestinationPlugin,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

export const BookProductAttributes = Schema.Struct({
  format: Schema.Literals(["hardcover", "paperback"]),
  isbn: Schema.NonEmptyString,
  pages: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  searchable: Schema.Boolean,
});

export const bookProductDraft = {
  key: "example-book",
  name: {
    "en-US": "Example Book",
  },
  productType: {
    key: "book",
    typeId: "product-type",
  },
  slug: {
    "en-US": "example-book",
  },
} satisfies ProductDraft;

const destinationContext = {
  definitionId: toMigrationDefinitionId("example-products"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-product"),
  sourceVersion: toSourceVersion("source-version-1"),
};

export interface ProductDestinationExampleResult {
  readonly attributes: readonly Attribute[];
  readonly created: DestinationCommandResult;
  readonly productDraftFields: readonly string[];
  readonly productDraftInventoryField: "absent" | "present";
  readonly rawThenChainedUpdateActionKinds: readonly string[];
  readonly sdkRequests: readonly RecordedCommercetoolsRequest[];
  readonly updateActionKinds: readonly string[];
  readonly updated: DestinationCommandResult;
}

export const runProductDestinationExample = Effect.fn(
  "runProductDestinationExample"
)(function* () {
  const recording = makeRecordingCommercetoolsApiRoot();
  const destination = CommercetoolsDestinationPlugin.make({
    productTypes: {
      book: BookProductAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot({
      apiRoot: recording.apiRoot,
      projectKey: "example-project",
    }),
  });
  const destinationPlugin = yield* DestinationPlugin.pipe(
    Effect.provide(destination.layer)
  );
  const attributes = yield* destination.helpers.products.attributes("book", {
    format: "paperback",
    isbn: "9780135957059",
    pages: 320,
    searchable: true,
  });

  const created = yield* destinationPlugin.execute(
    destination.commands.products.createDraft({
      ...bookProductDraft,
      masterVariant: {
        attributes,
        sku: "example-book-paperback",
      },
    }),
    destinationContext
  );
  const productVersion = Number(created.metadata?.productVersion ?? 1);

  const updateCommand = destination.commands.products
    .update({
      selector: {
        id: String(created.destinationIdentity),
        kind: "id",
      },
      version: productVersion,
    })
    .changeName({
      name: {
        "en-US": "Example Book Updated",
      },
      staged: true,
    })
    .changeSlug({
      slug: {
        "en-US": "example-book-updated",
      },
      staged: true,
    })
    .setDescription({
      description: {
        "en-US": "Updated through a chainable SDK-typed action builder.",
      },
      staged: true,
    })
    .publish()
    .command();

  const rawThenChainedUpdateCommand = destination.commands.products.update
    .withActions({
      actions: updateCommand.actions,
      selector: {
        id: String(created.destinationIdentity),
        kind: "id",
      },
      version: productVersion,
    })
    .unpublish()
    .command();
  const updateActionKinds: ReadonlyArray<
    "changeName" | "changeSlug" | "setDescription" | "publish"
  > = updateCommand.actions.map((action) => action.action);
  const rawThenChainedUpdateActionKinds: ReadonlyArray<
    "changeName" | "changeSlug" | "setDescription" | "publish" | "unpublish"
  > = rawThenChainedUpdateCommand.actions.map((action) => action.action);

  const updated = yield* destinationPlugin.execute(
    updateCommand,
    destinationContext
  );
  const productDraftFields = Object.keys(bookProductDraft);

  return {
    attributes,
    created,
    productDraftFields,
    productDraftInventoryField: productDraftFields.includes("inventoryMode")
      ? "present"
      : "absent",
    rawThenChainedUpdateActionKinds,
    sdkRequests: recording.requests,
    updateActionKinds,
    updated,
  } satisfies ProductDestinationExampleResult;
});

export const formatProductDestinationExampleResult = (
  result: ProductDestinationExampleResult
): string =>
  [
    "Commercetools Product Destination Example",
    `created: ${result.created.destinationIdentity}`,
    `created version: ${result.created.destinationVersion}`,
    `updated version: ${result.updated.destinationVersion}`,
    `attributes: ${result.attributes.map((attribute) => attribute.name).join(", ")}`,
    `update actions: ${result.updateActionKinds.join(", ")}`,
    `recorded SDK requests: ${result.sdkRequests.length}`,
  ].join("\n");

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  Effect.runPromise(
    runProductDestinationExample().pipe(
      Effect.map(formatProductDestinationExampleResult),
      Effect.flatMap(Console.log)
    )
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
