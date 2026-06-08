import type { ProductDraft } from "@commercetools/platform-sdk";
import { Console, Effect } from "effect";
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
};

export const productUpdateActionBuilderTypecheck =
  assertProductUpdateActionBuilderTypes;

const program = Effect.gen(function* () {
  const recording = makeRecordingCommercetoolsApiRoot();
  const destination = CommercetoolsDestinationPlugin.make({
    projectKey: "prototype-project",
    sdkLayer: CommercetoolsSdk.layerFromApiRoot(recording.apiRoot),
  });
  const destinationPlugin = yield* DestinationPlugin.pipe(
    Effect.provide(destination.layer)
  );

  const created = yield* destinationPlugin.execute(
    destination.commands.products.createDraft(prototypeDraft),
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
