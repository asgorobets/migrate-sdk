import type { ProductDraft } from "@commercetools/platform-sdk";
import { Console, Effect, Schema } from "effect";
import {
  DestinationPlugin,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";
import {
  CommercetoolsDestinationPlugin,
  type NonEmptyProductUpdateActions,
} from "../destination/index.ts";
import { CommercetoolsSdk } from "../index.ts";
import { makeRecordingCommercetoolsApiRoot } from "../testing/index.ts";

const PrototypeBookAttributes = Schema.Struct({
  format: Schema.Literals(["hardcover", "paperback"]),
  isbn: Schema.NonEmptyString,
  pages: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  searchable: Schema.Boolean,
});

const DecodingPrototypeBookAttributes = Schema.Struct({
  pages: Schema.NumberFromString,
});

const PrototypeMagazineAttributes = Schema.Struct({
  issue: Schema.NonEmptyString,
});

interface PrototypeCatalogProductTypes {
  readonly book: typeof PrototypeBookAttributes;
  readonly magazine: typeof PrototypeMagazineAttributes;
}

const prototypeDraft = {
  key: "prototype-book",
  name: {
    "en-US": "Prototype Book",
  },
  productType: {
    key: "book",
    typeId: "product-type",
  },
  slug: {
    "en-US": "prototype-book",
  },
} satisfies ProductDraft;

const destinationContext = {
  definitionId: toMigrationDefinitionId("prototype-products"),
  runId: toMigrationRunId("prototype-run"),
  sourceIdentity: toSourceIdentity("prototype-source-product"),
  sourceVersion: toSourceVersion("source-version-1"),
};

const assertProductUpdateActionBuilderTypes = (): void => {
  const destination = CommercetoolsDestinationPlugin.make({
    projectKey: "prototype-project",
    productTypes: {
      book: PrototypeBookAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  });
  const emptyBuilder = destination.commands.products.update({
    selector: {
      key: "prototype-book",
      kind: "key",
    },
    version: 1,
  });

  // @ts-expect-error update commands require at least one chained action.
  emptyBuilder.command();

  // @ts-expect-error changeName must receive the SDK action input shape.
  emptyBuilder.changeName({ staged: true });

  // @ts-expect-error raw actions still need to satisfy ProductUpdateAction.
  emptyBuilder.raw({ action: "notAProductAction" });

  destination.commands.products.update.withActions({
    // @ts-expect-error withActions requires at least one action.
    actions: [],
    selector: {
      key: "prototype-book",
      kind: "key",
    },
    version: 1,
  });

  destination.commands.products.update.withActions({
    actions: [
      // @ts-expect-error withActions still needs SDK-typed ProductUpdateAction values.
      { action: "notAProductAction" },
    ],
    selector: {
      key: "prototype-book",
      kind: "key",
    },
    version: 1,
  });

  const command = emptyBuilder
    .changeName({
      name: {
        "en-US": "Prototype Book Updated",
      },
    })
    .publish()
    .command();

  command.actions satisfies NonEmptyProductUpdateActions;

  const destinationWithoutProductTypes = CommercetoolsDestinationPlugin.make({
    projectKey: "prototype-project",
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  });
  const noProductTypeAttributesEffect =
    // @ts-expect-error product attribute helpers are unavailable without configured product types.
    destinationWithoutProductTypes.helpers.products.attributes("book", {
      format: "paperback",
      isbn: "9780135957059",
      pages: 320,
      searchable: true,
    });

  const validAttributesEffect = destination.helpers.products.attributes(
    "book",
    {
      format: "paperback",
      isbn: "9780135957059",
      pages: 320,
      searchable: true,
    }
  );

  const destinationOptions = {
    projectKey: "prototype-project",
    productTypes: {
      book: PrototypeBookAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  };
  const destinationFromOptions =
    CommercetoolsDestinationPlugin.make(destinationOptions);
  const variableOptionsAttributesEffect =
    destinationFromOptions.helpers.products.attributes("book", {
      format: "paperback",
      isbn: "9780135957059",
      pages: 320,
      searchable: true,
    });

  const unknownProductTypeAttributesEffect =
    // @ts-expect-error product attribute helpers are scoped to configured product types.
    destination.helpers.products.attributes("magazine", {
      format: "paperback",
      isbn: "9780135957059",
      pages: 320,
      searchable: true,
    });

  const invalidAttributeBagEffect = destination.helpers.products.attributes(
    "book",
    {
      format: "paperback",
      isbn: "9780135957059",
      pages: 320,
      // @ts-expect-error attribute bags are inferred from the product type schema.
      searchable: "yes",
    }
  );

  const attributeHelperTypeAssertions = [
    noProductTypeAttributesEffect,
    validAttributesEffect,
    variableOptionsAttributesEffect,
    unknownProductTypeAttributesEffect,
    invalidAttributeBagEffect,
  ] satisfies readonly Effect.Effect<unknown, unknown, unknown>[];
  attributeHelperTypeAssertions.length satisfies number;

  // @ts-expect-error productTypes is required when a product type registry is explicit.
  CommercetoolsDestinationPlugin.make<PrototypeCatalogProductTypes>({
    projectKey: "prototype-project",
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  });

  CommercetoolsDestinationPlugin.make<PrototypeCatalogProductTypes>({
    projectKey: "prototype-project",
    // @ts-expect-error productTypes must include every explicitly configured product type key.
    productTypes: {
      book: PrototypeBookAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  });

  CommercetoolsDestinationPlugin.make<{
    readonly book: typeof PrototypeBookAttributes;
  }>({
    projectKey: "prototype-project",
    productTypes: {
      book: PrototypeBookAttributes,
      // @ts-expect-error productTypes must not include keys outside the explicit registry.
      magazine: PrototypeMagazineAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  });

  // @ts-expect-error destination attribute schemas validate pipeline-facing values without decoding.
  CommercetoolsDestinationPlugin.make({
    projectKey: "prototype-project",
    productTypes: {
      book: DecodingPrototypeBookAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(
      makeRecordingCommercetoolsApiRoot().apiRoot
    ),
  });
};

export const productUpdateActionBuilderTypecheck =
  assertProductUpdateActionBuilderTypes;

const program = Effect.gen(function* () {
  const recording = makeRecordingCommercetoolsApiRoot();
  const destination = CommercetoolsDestinationPlugin.make({
    projectKey: "prototype-project",
    productTypes: {
      book: PrototypeBookAttributes,
    },
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(recording.apiRoot),
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
      ...prototypeDraft,
      masterVariant: {
        attributes,
        sku: "prototype-book-paperback",
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
        "en-US": "Prototype Book Updated",
      },
      staged: true,
    })
    .changeSlug({
      slug: {
        "en-US": "prototype-book-updated",
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

  const updated = yield* destinationPlugin.execute(
    updateCommand,
    destinationContext
  );

  yield* Console.log(
    JSON.stringify(
      {
        attributes,
        created,
        productDraftFields: Object.keys(prototypeDraft),
        productDraftInventoryField: "absent",
        rawThenChainedUpdateActionKinds:
          rawThenChainedUpdateCommand.actions.map((action) => action.action),
        updateActionKinds: updateCommand.actions.map((action) => action.action),
        updated,
        sdkRequests: recording.requests,
      },
      null,
      2
    )
  );
});

await Effect.runPromise(program);
