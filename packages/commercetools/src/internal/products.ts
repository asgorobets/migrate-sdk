import type {
  Product,
  ProductDraft,
  ProductPublishAction,
  ProductPublishScope,
  ProductUpdate,
  ProductUpdateAction,
} from "@commercetools/platform-sdk";
import { Context, Effect, Layer } from "effect";
import { CommercetoolsSdk, type CommercetoolsSdkError } from "../sdk.ts";

export type CommercetoolsProductSelector =
  | {
      readonly id: string;
      readonly kind: "id";
    }
  | {
      readonly key: string;
      readonly kind: "key";
    };

export interface CommercetoolsPublishProductInput {
  readonly scope?: ProductPublishScope;
  readonly selector: CommercetoolsProductSelector;
  readonly version: number;
}

export type CommercetoolsProductUpdateActions = readonly [
  ProductUpdateAction,
  ...ProductUpdateAction[],
];

export interface CommercetoolsUpdateProductInput {
  readonly actions: CommercetoolsProductUpdateActions;
  readonly selector: CommercetoolsProductSelector;
  readonly version: number;
}

export interface CommercetoolsProductsLayerOptions {
  readonly projectKey: string;
}

export class CommercetoolsProducts extends Context.Service<
  CommercetoolsProducts,
  {
    readonly createProductDraft: (
      draft: ProductDraft
    ) => Effect.Effect<Product, CommercetoolsSdkError>;
    readonly publishProduct: (
      input: CommercetoolsPublishProductInput
    ) => Effect.Effect<Product, CommercetoolsSdkError>;
    readonly updateProduct: (
      input: CommercetoolsUpdateProductInput
    ) => Effect.Effect<Product, CommercetoolsSdkError>;
  }
>()("@migrate-sdk/commercetools/CommercetoolsProducts") {
  static readonly layer = (
    options: CommercetoolsProductsLayerOptions
  ): Layer.Layer<CommercetoolsProducts, never, CommercetoolsSdk> =>
    Layer.effect(
      CommercetoolsProducts,
      Effect.gen(function* () {
        const sdk = yield* CommercetoolsSdk;
        const project = sdk.apiRoot.withProjectKey({
          projectKey: options.projectKey,
        });

        const createProductDraft = Effect.fn(
          "CommercetoolsProducts.createProductDraft"
        )((draft: ProductDraft) =>
          sdk.execute(
            "products.createDraft",
            project.products().post({
              body: {
                ...draft,
                publish: false,
              },
            })
          )
        );

        const publishProduct = Effect.fn(
          "CommercetoolsProducts.publishProduct"
        )((input: CommercetoolsPublishProductInput) => {
          const action: ProductPublishAction = {
            action: "publish",
            ...(input.scope === undefined ? {} : { scope: input.scope }),
          };
          const body: ProductUpdate = {
            actions: [action],
            version: input.version,
          };
          const products = project.products();
          const product =
            input.selector.kind === "id"
              ? products.withId({ ID: input.selector.id })
              : products.withKey({ key: input.selector.key });

          return sdk.execute(
            "products.publish",
            product.post({
              body,
            })
          );
        });

        const updateProduct = Effect.fn("CommercetoolsProducts.updateProduct")(
          (input: CommercetoolsUpdateProductInput) => {
            const body: ProductUpdate = {
              actions: [...input.actions],
              version: input.version,
            };
            const products = project.products();
            const product =
              input.selector.kind === "id"
                ? products.withId({ ID: input.selector.id })
                : products.withKey({ key: input.selector.key });

            return sdk.execute(
              "products.update",
              product.post({
                body,
              })
            );
          }
        );

        return {
          createProductDraft,
          publishProduct,
          updateProduct,
        };
      })
    );
}
