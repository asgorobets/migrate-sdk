import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import {
  CommercetoolsDestinationPlugin,
  type CommercetoolsProductHelpers,
  CreateProductDraftCommand,
  type ProductUpdateActionByName,
  type ProductUpdateFactory,
  UpdateProductCommand,
} from "@migrate-sdk/commercetools/destination";
import { makeRecordingCommercetoolsApiRoot } from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import {
  BookProductAttributes,
  BookVariantAttributes,
  bookProductDraft,
  formatProductDestinationExampleResult,
  runProductDestinationExample,
} from "./product-destination.ts";

const assertProductUpdateActionTypes = () => {
  const publish: ProductUpdateActionByName<"publish"> = {
    action: "publish",
  };
  const changeName: ProductUpdateActionByName<"changeName"> = {
    action: "changeName",
    name: {
      "en-US": "Example Book Updated",
    },
  };

  // @ts-expect-error Product changeName actions require name.
  const missingName: ProductUpdateActionByName<"changeName"> = {
    action: "changeName",
  };

  return [publish, changeName, missingName];
};

const assertProductUpdateBuilderTypes = (update: ProductUpdateFactory) => {
  const builder = update({
    selector: {
      id: "recording-product-id",
      kind: "id",
    },
    version: 1,
  });

  builder.action({
    action: "publish",
  });
  builder.action({
    action: "changeName",
    name: {
      "en-US": "Example Book Updated",
    },
  });

  // @ts-expect-error The SDK product action union does not include this action.
  builder.action({ action: "unknownProductAction" });
  // @ts-expect-error Product changeName actions require name.
  builder.action({ action: "changeName" });
};

const assertProductAttributeHelperTypes = (
  helpers: CommercetoolsProductHelpers<{
    readonly book: {
      readonly attributes: typeof BookVariantAttributes;
      readonly productAttributes: typeof BookProductAttributes;
    };
  }>
) => {
  helpers.productAttributes("book").withAttributes({
    searchable: true,
  });
  helpers.productAttributes("book").withAttributes({
    // @ts-expect-error Product-level attributes use the product attribute schema.
    format: "paperback",
  });
  helpers.attributes("book").withAttributes({
    format: "paperback",
  });
  helpers.attributes("book").withAttributes({
    // @ts-expect-error Variant attributes use the variant attribute schema.
    searchable: true,
  });
  helpers.attributes("book").withAttributes({}).set("pages", 320);
  helpers.attributes("book").withAttributes({}).set(
    "pages",
    // @ts-expect-error pages must match the configured variant attribute schema.
    "320"
  );
  helpers.productAttributes("book").withAttributes({}).unset(
    // @ts-expect-error unset is restricted to configured product attribute names.
    "isbn"
  );
  const allVariantActions = helpers
    .attributes("book")
    .withAttributes({})
    .toActions({
      allVariants: true,
      staged: false,
    });
  const skuActions = helpers.attributes("book").withAttributes({}).toActions({
    sku: "book-sku",
    staged: true,
  });
  const variantIdActions = helpers
    .attributes("book")
    .withAttributes({})
    .toActions({
      variantId: 1,
    });
  const invalidTargetActions = helpers
    .attributes("book")
    .withAttributes({})
    // @ts-expect-error A variant attribute action target must be one target mode.
    .toActions({
      allVariants: true,
      sku: "book-sku",
    });

  return [
    allVariantActions,
    skuActions,
    variantIdActions,
    invalidTargetActions,
  ];
};

describe("product destination example", () => {
  it.effect(
    "runs create and update product commands with typed attributes",
    () =>
      Effect.gen(function* () {
        const result = yield* runProductDestinationExample();
        const output = formatProductDestinationExampleResult(result);
        const createRequest = result.sdkRequests[0];
        const updateRequest = result.sdkRequests[1];
        const createDraft =
          createRequest?.body !== undefined &&
          "productType" in createRequest.body
            ? createRequest.body
            : undefined;
        const productUpdate =
          updateRequest?.body !== undefined && "actions" in updateRequest.body
            ? updateRequest.body
            : undefined;

        expect(result.created.destinationIdentity).toBe("recording-product-id");
        expect(result.created.destinationVersion).toBe("1");
        expect(result.updated.destinationVersion).toBe("2");
        expect(result.attributes).toEqual([
          { name: "format", value: "paperback" },
          { name: "isbn", value: "9780135957059" },
          { name: "pages", value: 320 },
        ]);
        expect(result.productAttributes).toEqual([
          { name: "displayFamily", value: "programming" },
          { name: "searchable", value: true },
        ]);
        expect(result.productDraftInventoryField).toBe("absent");
        expect(result.updateActionKinds).toEqual([
          "setProductAttribute",
          "setProductAttribute",
          "setAttribute",
          "setAttribute",
          "changeName",
          "changeSlug",
          "setDescription",
          "publish",
        ]);
        expect(result.withActionsThenChainedUpdateActionKinds).toEqual([
          "setProductAttribute",
          "setProductAttribute",
          "setAttribute",
          "setAttribute",
          "changeName",
          "changeSlug",
          "setDescription",
          "publish",
          "unpublish",
        ]);
        expect(result.sdkRequests).toHaveLength(2);
        expect(createDraft?.attributes).toEqual(result.productAttributes);
        expect(createDraft?.masterVariant?.attributes).toEqual(
          result.attributes
        );
        expect(createDraft?.masterVariant?.sku).toBe("example-book-paperback");
        expect(productUpdate?.actions.map((action) => action.action)).toEqual(
          result.updateActionKinds
        );
        expect(productUpdate?.actions.slice(0, 4)).toEqual([
          {
            action: "setProductAttribute",
            name: "searchable",
            staged: false,
            value: false,
          },
          {
            action: "setProductAttribute",
            name: "displayFamily",
            staged: false,
          },
          {
            action: "setAttribute",
            name: "format",
            sku: "example-book-paperback",
            staged: true,
            value: "hardcover",
          },
          {
            action: "setAttribute",
            name: "isbn",
            sku: "example-book-paperback",
            staged: true,
          },
        ]);
        expect(output).toContain("Commercetools Product Destination Example");
        expect(output).toContain(
          "product attributes: displayFamily, searchable"
        );
        expect(output).toContain("variant attributes: format, isbn, pages");
      })
  );

  it.effect(
    "rejects product drafts without exactly one product type identifier",
    () =>
      Effect.gen(function* () {
        const missingIdentifierError = yield* Schema.decodeUnknownEffect(
          CreateProductDraftCommand
        )({
          draft: {
            ...bookProductDraft,
            productType: {
              typeId: "product-type",
            },
          },
          kind: "CreateProductDraft",
        }).pipe(Effect.flip);
        const ambiguousIdentifierError = yield* Schema.decodeUnknownEffect(
          CreateProductDraftCommand
        )({
          draft: {
            ...bookProductDraft,
            productType: {
              id: "book-product-type-id",
              key: "book",
              typeId: "product-type",
            },
          },
          kind: "CreateProductDraft",
        }).pipe(Effect.flip);
        const emptyIdWithKeyError = yield* Schema.decodeUnknownEffect(
          CreateProductDraftCommand
        )({
          draft: {
            ...bookProductDraft,
            productType: {
              id: "",
              key: "book",
              typeId: "product-type",
            },
          },
          kind: "CreateProductDraft",
        }).pipe(Effect.flip);
        const idWithEmptyKeyError = yield* Schema.decodeUnknownEffect(
          CreateProductDraftCommand
        )({
          draft: {
            ...bookProductDraft,
            productType: {
              id: "book-product-type-id",
              key: "",
              typeId: "product-type",
            },
          },
          kind: "CreateProductDraft",
        }).pipe(Effect.flip);

        expect(missingIdentifierError).toBeDefined();
        expect(ambiguousIdentifierError).toBeDefined();
        expect(emptyIdWithKeyError).toBeDefined();
        expect(idWithEmptyKeyError).toBeDefined();
      })
  );

  it("types product actions from the SDK action union", () => {
    expect(assertProductUpdateActionTypes).toBeTypeOf("function");
    expect(assertProductUpdateBuilderTypes).toBeTypeOf("function");
    expect(assertProductAttributeHelperTypes).toBeTypeOf("function");
  });

  it.effect(
    "rejects attribute values that do not match configured schemas",
    () =>
      Effect.gen(function* () {
        const recording = makeRecordingCommercetoolsApiRoot();
        const destination = CommercetoolsDestinationPlugin.make({
          productTypes: {
            book: {
              attributes: BookVariantAttributes,
              productAttributes: BookProductAttributes,
            },
          },
          sdkLayer: CommercetoolsSdk.layerFromApiRoot({
            apiRoot: recording.apiRoot,
            projectKey: "example-project",
          }),
        });
        const invalidVariantAttributeError = yield* destination.helpers.products
          .attributes("book")
          .withAttributes({})
          .set(
            "pages",
            // @ts-expect-error Runtime validation protects untyped callers too.
            "320"
          )
          .toDraft()
          .pipe(Effect.flip);
        const invalidProductAttributeError = yield* destination.helpers.products
          .productAttributes("book")
          .withAttributes({
            // @ts-expect-error Runtime validation protects untyped callers too.
            searchable: "yes",
          })
          .toActions()
          .pipe(Effect.flip);

        expect(Schema.isSchemaError(invalidVariantAttributeError)).toBe(true);
        expect(Schema.isSchemaError(invalidProductAttributeError)).toBe(true);
      })
  );

  it.effect("validates the product update command envelope", () =>
    Effect.gen(function* () {
      const validAction = yield* Schema.decodeUnknownEffect(
        UpdateProductCommand
      )({
        actions: [
          {
            action: "changeName",
          },
        ],
        kind: "UpdateProduct",
        selector: {
          id: "recording-product-id",
          kind: "id",
        },
        version: 1,
      });
      const missingActionError = yield* Schema.decodeUnknownEffect(
        UpdateProductCommand
      )({
        actions: [
          {
            name: {
              "en-US": "Example Book Updated",
            },
          },
        ],
        kind: "UpdateProduct",
        selector: {
          id: "recording-product-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);
      const emptyActionsError = yield* Schema.decodeUnknownEffect(
        UpdateProductCommand
      )({
        actions: [],
        kind: "UpdateProduct",
        selector: {
          id: "recording-product-id",
          kind: "id",
        },
        version: 1,
      }).pipe(Effect.flip);

      expect(validAction.actions).toEqual([
        {
          action: "changeName",
        },
      ]);
      expect(missingActionError).toBeDefined();
      expect(emptyActionsError).toBeDefined();
    })
  );
});
