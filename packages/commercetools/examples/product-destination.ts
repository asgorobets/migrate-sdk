import { fileURLToPath } from "node:url";
import type {
  Attribute,
  Product,
  ProductData,
} from "@commercetools/platform-sdk";
import {
  CommercetoolsDestinationPlugin,
  type ProductDraftInput,
} from "@migrate-sdk/commercetools/destination";
import {
  makeScriptedCommercetoolsSdk,
  type ScriptedCommercetoolsSdkRequest,
  scriptedCommercetoolsSdkRoute,
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
  displayFamily: Schema.optional(Schema.String),
  searchable: Schema.Boolean,
});

export const BookVariantAttributes = Schema.Struct({
  format: Schema.Literals(["hardcover", "paperback"]),
  isbn: Schema.NonEmptyString,
  pages: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
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
} satisfies ProductDraftInput;

const destinationContext = {
  definitionId: toMigrationDefinitionId("example-products"),
  runId: toMigrationRunId("example-run"),
  sourceIdentity: toSourceIdentity("example-source-product"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isProductUpdateBody = (
  body: unknown
): body is { readonly actions: readonly { readonly action?: unknown }[] } =>
  isRecord(body) && Array.isArray(body.actions);

const productResponse = ({
  published,
  version,
}: {
  readonly published: boolean;
  readonly version: number;
}): Product => {
  const data: ProductData = {
    attributes: [],
    categories: [],
    masterVariant: {
      id: 1,
    },
    name: bookProductDraft.name,
    searchKeywords: {},
    slug: bookProductDraft.slug,
    variants: [],
  };

  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "recording-product-id",
    key: bookProductDraft.key,
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    masterData: {
      current: data,
      hasStagedChanges: !published,
      published,
      staged: data,
    },
    productType: {
      id: "book",
      typeId: "product-type",
    },
    version,
  };
};

export interface ProductDestinationExampleResult {
  readonly attributes: readonly Attribute[];
  readonly created: DestinationCommandResult;
  readonly productAttributes: readonly Attribute[];
  readonly productDraftFields: readonly string[];
  readonly productDraftInventoryField: "absent" | "present";
  readonly sdkRequests: readonly ScriptedCommercetoolsSdkRequest[];
  readonly updateActionKinds: readonly string[];
  readonly updated: DestinationCommandResult;
  readonly withActionsThenChainedUpdateActionKinds: readonly string[];
}

export const runProductDestinationExample = Effect.fn(
  "runProductDestinationExample"
)(function* () {
  const sdk = makeScriptedCommercetoolsSdk({
    projectKey: "example-project",
    routes: [
      scriptedCommercetoolsSdkRoute("products.createDraft")
        .matchBody((body) => isRecord(body) && "productType" in body)
        .reply(productResponse({ published: false, version: 1 })),
      scriptedCommercetoolsSdkRoute("products.update")
        .matchBody(
          (body) =>
            isProductUpdateBody(body) &&
            body.actions.some((action) => action.action === "publish")
        )
        .reply(productResponse({ published: true, version: 2 })),
    ],
  });
  const destination = CommercetoolsDestinationPlugin.make({
    productTypes: {
      book: {
        attributes: BookVariantAttributes,
        productAttributes: BookProductAttributes,
      },
    },
    sdkLayer: sdk.layer,
  });
  const destinationPlugin = yield* DestinationPlugin.pipe(
    Effect.provide(destination.layer)
  );
  const productAttributes = yield* destination.helpers.products
    .productAttributes("book")
    .withAttributes({
      displayFamily: "programming",
      searchable: true,
    })
    .toDraft();
  const attributes = yield* destination.helpers.products
    .attributes("book")
    .withAttributes({
      format: "paperback",
      isbn: "9780135957059",
    })
    .set("pages", 320)
    .toDraft();

  const created = yield* destinationPlugin.execute(
    destination.commands.products.createDraft({
      ...bookProductDraft,
      attributes: productAttributes,
      masterVariant: {
        attributes,
        sku: "example-book-paperback",
      },
    }),
    destinationContext
  );
  const productVersion = Number(created.metadata?.productVersion ?? 1);
  const productAttributeActions = yield* destination.helpers.products
    .productAttributes("book")
    .withAttributes({
      searchable: false,
    })
    .unset("displayFamily")
    .toActions({ staged: false });
  const variantAttributeActions = yield* destination.helpers.products
    .attributes("book")
    .withAttributes({
      format: "hardcover",
    })
    .unset("isbn")
    .toActions({ sku: "example-book-paperback", staged: true });

  const updateCommand = destination.commands.products
    .update({
      selector: {
        id: String(created.destinationIdentity),
        kind: "id",
      },
      version: productVersion,
    })
    .withActions(productAttributeActions)
    .withActions(variantAttributeActions)
    .action({
      action: "changeName",
      name: {
        "en-US": "Example Book Updated",
      },
      staged: true,
    })
    .action({
      action: "changeSlug",
      slug: {
        "en-US": "example-book-updated",
      },
      staged: true,
    })
    .action({
      action: "setDescription",
      description: {
        "en-US": "Updated through a chainable SDK-typed action builder.",
      },
      staged: true,
    })
    .action({ action: "publish" })
    .command();

  const withActionsThenChainedUpdateCommand =
    destination.commands.products.update
      .withActions({
        actions: updateCommand.actions,
        selector: {
          id: String(created.destinationIdentity),
          kind: "id",
        },
        version: productVersion,
      })
      .action({ action: "unpublish" })
      .command();
  const updateActionKinds: ReadonlyArray<
    | "changeName"
    | "changeSlug"
    | "publish"
    | "setAttribute"
    | "setDescription"
    | "setProductAttribute"
  > = updateCommand.actions.map((action) => action.action);
  const withActionsThenChainedUpdateActionKinds: ReadonlyArray<
    | "changeName"
    | "changeSlug"
    | "publish"
    | "setAttribute"
    | "setDescription"
    | "setProductAttribute"
    | "unpublish"
  > = withActionsThenChainedUpdateCommand.actions.map(
    (action) => action.action
  );

  const updated = yield* destinationPlugin.execute(
    updateCommand,
    destinationContext
  );
  const productDraftFields = Object.keys(bookProductDraft);

  return {
    attributes,
    created,
    productAttributes,
    productDraftFields,
    productDraftInventoryField: productDraftFields.includes("inventoryMode")
      ? "present"
      : "absent",
    withActionsThenChainedUpdateActionKinds,
    sdkRequests: sdk.requests,
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
    `product attributes: ${result.productAttributes.map((attribute) => attribute.name).join(", ")}`,
    `variant attributes: ${result.attributes.map((attribute) => attribute.name).join(", ")}`,
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
