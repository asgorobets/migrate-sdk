import { describe, expect, it } from "@effect/vitest";
import {
  CreateProductDraftCommand,
  type ProductUpdateActionByName,
  type ProductUpdateFactory,
  UpdateProductCommand,
} from "@migrate-sdk/commercetools/destination";
import { Effect, Schema } from "effect";
import {
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
          { name: "searchable", value: true },
        ]);
        expect(result.productDraftInventoryField).toBe("absent");
        expect(result.updateActionKinds).toEqual([
          "changeName",
          "changeSlug",
          "setDescription",
          "publish",
        ]);
        expect(result.withActionsThenChainedUpdateActionKinds).toEqual([
          "changeName",
          "changeSlug",
          "setDescription",
          "publish",
          "unpublish",
        ]);
        expect(result.sdkRequests).toHaveLength(2);
        expect(createDraft?.masterVariant?.attributes).toEqual(
          result.attributes
        );
        expect(createDraft?.masterVariant?.sku).toBe("example-book-paperback");
        expect(productUpdate?.actions.map((action) => action.action)).toEqual(
          result.updateActionKinds
        );
        expect(output).toContain("Commercetools Product Destination Example");
        expect(output).toContain("attributes: format, isbn, pages, searchable");
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
  });

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
