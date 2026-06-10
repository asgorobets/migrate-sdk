import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import {
  CommercetoolsDestinationPlugin,
  type CommercetoolsProductHelpers,
  CreateProductDraftCommand,
  type ProductDraftInput,
  type ProductPriceDraftInput,
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
  const addToCategory: ProductUpdateActionByName<"addToCategory"> = {
    action: "addToCategory",
    category: {
      key: "programming",
      typeId: "category",
    },
  };
  const setTaxCategory: ProductUpdateActionByName<"setTaxCategory"> = {
    action: "setTaxCategory",
    taxCategory: {
      id: "standard-tax-category-id",
      typeId: "tax-category",
    },
  };
  const removeTaxCategory: ProductUpdateActionByName<"setTaxCategory"> = {
    action: "setTaxCategory",
  };
  const transitionState: ProductUpdateActionByName<"transitionState"> = {
    action: "transitionState",
    state: {
      key: "published-review",
      typeId: "state",
    },
  };
  const setProductPriceCustomType: ProductUpdateActionByName<"setProductPriceCustomType"> =
    {
      action: "setProductPriceCustomType",
      priceId: "embedded-price-id",
      type: {
        key: "repoEmbeddedPrice",
        typeId: "type",
      },
    };
  const embeddedPrice: ProductPriceDraftInput = {
    channel: {
      key: "web",
      typeId: "channel",
    },
    custom: {
      fields: {
        source: "migration",
      },
      type: {
        key: "repoEmbeddedPrice",
        typeId: "type",
      },
    },
    customerGroup: {
      id: "vip-customer-group-id",
      typeId: "customer-group",
    },
    recurrencePolicy: {
      key: "monthly",
      typeId: "recurrence-policy",
    },
    value: {
      centAmount: 1999,
      currencyCode: "USD",
    },
  };
  const addPrice: ProductUpdateActionByName<"addPrice"> = {
    action: "addPrice",
    price: embeddedPrice,
    sku: "example-book-paperback",
  };
  const setPrices: ProductUpdateActionByName<"setPrices"> = {
    action: "setPrices",
    prices: [embeddedPrice],
    sku: "example-book-paperback",
  };

  // @ts-expect-error Product changeName actions require name.
  const missingName: ProductUpdateActionByName<"changeName"> = {
    action: "changeName",
  };
  const missingCategoryIdentifier: ProductUpdateActionByName<"addToCategory"> =
    {
      action: "addToCategory",
      // @ts-expect-error Category resource identifiers require id or key.
      category: {
        typeId: "category",
      },
    };
  const ambiguousStateIdentifier: ProductUpdateActionByName<"transitionState"> =
    {
      action: "transitionState",
      state: {
        id: "published-review-id",
        // @ts-expect-error State resource identifiers accept id or key, not both.
        key: "published-review",
        typeId: "state",
      },
    };
  const missingCustomTypeIdentifier: ProductUpdateActionByName<"setProductPriceCustomType"> =
    {
      action: "setProductPriceCustomType",
      priceId: "embedded-price-id",
      // @ts-expect-error Type resource identifiers require id or key.
      type: {
        typeId: "type",
      },
    };
  const missingPriceChannelIdentifier: ProductUpdateActionByName<"addPrice"> = {
    action: "addPrice",
    price: {
      // @ts-expect-error Price channel resource identifiers require id or key.
      channel: {
        typeId: "channel",
      },
      value: {
        centAmount: 1999,
        currencyCode: "USD",
      },
    },
    sku: "example-book-paperback",
  };
  const ambiguousPriceRecurrencePolicyIdentifier: ProductUpdateActionByName<"setPrices"> =
    {
      action: "setPrices",
      prices: [
        {
          recurrencePolicy: {
            id: "monthly-policy-id",
            // @ts-expect-error Price recurrence policy identifiers accept id or key, not both.
            key: "monthly",
            typeId: "recurrence-policy",
          },
          value: {
            centAmount: 1999,
            currencyCode: "USD",
          },
        },
      ],
      sku: "example-book-paperback",
    };
  const missingPriceCustomTypeIdentifier: ProductUpdateActionByName<"addPrice"> =
    {
      action: "addPrice",
      price: {
        custom: {
          fields: {
            source: "migration",
          },
          // @ts-expect-error Price custom type resource identifiers require id or key.
          type: {
            typeId: "type",
          },
        },
        value: {
          centAmount: 1999,
          currencyCode: "USD",
        },
      },
      sku: "example-book-paperback",
    };

  return [
    publish,
    changeName,
    addToCategory,
    setTaxCategory,
    removeTaxCategory,
    transitionState,
    setProductPriceCustomType,
    addPrice,
    setPrices,
    missingName,
    missingCategoryIdentifier,
    ambiguousStateIdentifier,
    missingCustomTypeIdentifier,
    missingPriceChannelIdentifier,
    ambiguousPriceRecurrencePolicyIdentifier,
    missingPriceCustomTypeIdentifier,
  ];
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
  builder.withActions([
    {
      action: "changeSlug",
      slug: {
        "en-US": "example-book-updated",
      },
    },
  ]);
  builder
    .action({
      action: "publish",
    })
    .withActions([])
    .withActions([
      {
        action: "unpublish",
      },
    ])
    .command();

  // @ts-expect-error The SDK product action union does not include this action.
  builder.action({ action: "unknownProductAction" });
  // @ts-expect-error Product changeName actions require name.
  builder.action({ action: "changeName" });
  // @ts-expect-error withActions requires at least one action.
  builder.withActions([]);
  builder.withActions([
    // @ts-expect-error The SDK product action union does not include this action.
    { action: "unknownProductAction" },
  ]);
  builder.withActions([
    // @ts-expect-error Product changeName actions require name.
    { action: "changeName" },
  ]);
  builder.action({
    action: "addToCategory",
    // @ts-expect-error Category resource identifiers require id or key.
    category: {
      typeId: "category",
    },
  });
  builder.action({
    action: "setTaxCategory",
    taxCategory: {
      id: "standard-tax-category-id",
      // @ts-expect-error Tax category resource identifiers accept id or key, not both.
      key: "standard",
      typeId: "tax-category",
    },
  });
  builder.action({
    action: "transitionState",
    // @ts-expect-error State resource identifiers require id or key.
    state: {
      typeId: "state",
    },
  });
  builder.action({
    action: "setProductPriceCustomType",
    priceId: "embedded-price-id",
    // @ts-expect-error Type resource identifiers require id or key.
    type: {
      typeId: "type",
    },
  });
  builder.action({
    action: "addPrice",
    price: {
      // @ts-expect-error Price channel resource identifiers require id or key.
      channel: {
        typeId: "channel",
      },
      value: {
        centAmount: 1999,
        currencyCode: "USD",
      },
    },
    sku: "example-book-paperback",
  });
  builder.action({
    action: "setPrices",
    prices: [
      {
        customerGroup: {
          id: "vip-customer-group-id",
          // @ts-expect-error Price customer group identifiers accept id or key, not both.
          key: "vip",
          typeId: "customer-group",
        },
        value: {
          centAmount: 1999,
          currencyCode: "USD",
        },
      },
    ],
    sku: "example-book-paperback",
  });
};

const assertProductDraftResourceIdentifierTypes = () => {
  const productDraft: ProductDraftInput = {
    ...bookProductDraft,
    categories: [
      {
        key: "programming",
        typeId: "category",
      },
    ],
    state: {
      key: "published-review",
      typeId: "state",
    },
    taxCategory: {
      id: "standard-tax-category-id",
      typeId: "tax-category",
    },
    masterVariant: {
      prices: [
        {
          channel: {
            key: "web",
            typeId: "channel",
          },
          value: {
            centAmount: 1999,
            currencyCode: "USD",
          },
        },
      ],
      sku: "example-book-paperback",
    },
    variants: [
      {
        prices: [
          {
            custom: {
              fields: {
                source: "migration",
              },
              type: {
                key: "repoEmbeddedPrice",
                typeId: "type",
              },
            },
            value: {
              centAmount: 2499,
              currencyCode: "USD",
            },
          },
        ],
        sku: "example-book-hardcover",
      },
    ],
  };
  const productTypeById: ProductDraftInput = {
    ...bookProductDraft,
    productType: {
      id: "book-product-type-id",
      typeId: "product-type",
    },
  };
  const missingProductTypeIdentifier: ProductDraftInput = {
    ...bookProductDraft,
    // @ts-expect-error Product type resource identifiers require id or key.
    productType: {
      typeId: "product-type",
    },
  };
  const ambiguousCategoryIdentifier: ProductDraftInput = {
    ...bookProductDraft,
    categories: [
      // @ts-expect-error Category resource identifiers accept id or key, not both.
      {
        id: "programming-category-id",
        key: "programming",
        typeId: "category",
      },
    ],
  };
  const missingMasterVariantPriceChannelIdentifier: ProductDraftInput = {
    ...bookProductDraft,
    masterVariant: {
      prices: [
        {
          // @ts-expect-error Price channel resource identifiers require id or key.
          channel: {
            typeId: "channel",
          },
          value: {
            centAmount: 1999,
            currencyCode: "USD",
          },
        },
      ],
      sku: "example-book-paperback",
    },
  };
  const missingVariantPriceCustomTypeIdentifier: ProductDraftInput = {
    ...bookProductDraft,
    variants: [
      {
        prices: [
          {
            custom: {
              fields: {
                source: "migration",
              },
              // @ts-expect-error Price custom type resource identifiers require id or key.
              type: {
                typeId: "type",
              },
            },
            value: {
              centAmount: 2499,
              currencyCode: "USD",
            },
          },
        ],
        sku: "example-book-hardcover",
      },
    ],
  };

  return [
    productDraft,
    productTypeById,
    missingProductTypeIdentifier,
    ambiguousCategoryIdentifier,
    missingMasterVariantPriceChannelIdentifier,
    missingVariantPriceCustomTypeIdentifier,
  ];
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
        const missingCategoryIdentifierError =
          yield* Schema.decodeUnknownEffect(CreateProductDraftCommand)({
            draft: {
              ...bookProductDraft,
              categories: [
                {
                  typeId: "category",
                },
              ],
            },
            kind: "CreateProductDraft",
          }).pipe(Effect.flip);
        const ambiguousTaxCategoryIdentifierError =
          yield* Schema.decodeUnknownEffect(CreateProductDraftCommand)({
            draft: {
              ...bookProductDraft,
              taxCategory: {
                id: "standard-tax-category-id",
                key: "standard",
                typeId: "tax-category",
              },
            },
            kind: "CreateProductDraft",
          }).pipe(Effect.flip);
        const missingStateIdentifierError = yield* Schema.decodeUnknownEffect(
          CreateProductDraftCommand
        )({
          draft: {
            ...bookProductDraft,
            state: {
              typeId: "state",
            },
          },
          kind: "CreateProductDraft",
        }).pipe(Effect.flip);
        const missingMasterVariantPriceChannelIdentifierError =
          yield* Schema.decodeUnknownEffect(CreateProductDraftCommand)({
            draft: {
              ...bookProductDraft,
              masterVariant: {
                prices: [
                  {
                    channel: {
                      typeId: "channel",
                    },
                    value: {
                      centAmount: 1999,
                      currencyCode: "USD",
                    },
                  },
                ],
                sku: "example-book-paperback",
              },
            },
            kind: "CreateProductDraft",
          }).pipe(Effect.flip);
        const missingVariantPriceCustomTypeIdentifierError =
          yield* Schema.decodeUnknownEffect(CreateProductDraftCommand)({
            draft: {
              ...bookProductDraft,
              variants: [
                {
                  prices: [
                    {
                      custom: {
                        fields: {
                          source: "migration",
                        },
                        type: {
                          typeId: "type",
                        },
                      },
                      value: {
                        centAmount: 2499,
                        currencyCode: "USD",
                      },
                    },
                  ],
                  sku: "example-book-hardcover",
                },
              ],
            },
            kind: "CreateProductDraft",
          }).pipe(Effect.flip);

        expect(missingIdentifierError).toBeDefined();
        expect(ambiguousIdentifierError).toBeDefined();
        expect(emptyIdWithKeyError).toBeDefined();
        expect(idWithEmptyKeyError).toBeDefined();
        expect(missingCategoryIdentifierError).toBeDefined();
        expect(ambiguousTaxCategoryIdentifierError).toBeDefined();
        expect(missingStateIdentifierError).toBeDefined();
        expect(missingMasterVariantPriceChannelIdentifierError).toBeDefined();
        expect(missingVariantPriceCustomTypeIdentifierError).toBeDefined();
      })
  );

  it("types product actions from the SDK action union", () => {
    expect(assertProductUpdateActionTypes).toBeTypeOf("function");
    expect(assertProductUpdateBuilderTypes).toBeTypeOf("function");
    expect(assertProductDraftResourceIdentifierTypes).toBeTypeOf("function");
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
      const missingAddPriceChannelIdentifierError =
        yield* Schema.decodeUnknownEffect(UpdateProductCommand)({
          actions: [
            {
              action: "addPrice",
              price: {
                channel: {
                  typeId: "channel",
                },
                value: {
                  centAmount: 1999,
                  currencyCode: "USD",
                },
              },
              sku: "example-book-paperback",
            },
          ],
          kind: "UpdateProduct",
          selector: {
            id: "recording-product-id",
            kind: "id",
          },
          version: 1,
        }).pipe(Effect.flip);
      const ambiguousSetPricesRecurrencePolicyIdentifierError =
        yield* Schema.decodeUnknownEffect(UpdateProductCommand)({
          actions: [
            {
              action: "setPrices",
              prices: [
                {
                  recurrencePolicy: {
                    id: "monthly-policy-id",
                    key: "monthly",
                    typeId: "recurrence-policy",
                  },
                  value: {
                    centAmount: 1999,
                    currencyCode: "USD",
                  },
                },
              ],
              sku: "example-book-paperback",
            },
          ],
          kind: "UpdateProduct",
          selector: {
            id: "recording-product-id",
            kind: "id",
          },
          version: 1,
        }).pipe(Effect.flip);
      const missingAddVariantPriceCustomTypeIdentifierError =
        yield* Schema.decodeUnknownEffect(UpdateProductCommand)({
          actions: [
            {
              action: "addVariant",
              prices: [
                {
                  custom: {
                    fields: {
                      source: "migration",
                    },
                    type: {
                      typeId: "type",
                    },
                  },
                  value: {
                    centAmount: 2499,
                    currencyCode: "USD",
                  },
                },
              ],
              sku: "example-book-hardcover",
            },
          ],
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
      expect(missingAddPriceChannelIdentifierError).toBeDefined();
      expect(ambiguousSetPricesRecurrencePolicyIdentifierError).toBeDefined();
      expect(missingAddVariantPriceCustomTypeIdentifierError).toBeDefined();
    })
  );
});
