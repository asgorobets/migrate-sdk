import type {
  Product,
  ProductPagedQueryResponse,
} from "@commercetools/platform-sdk";
import type {
  CommercetoolsEntitySourceBaseOptions,
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsSourceProjection,
  ConfiguredCommercetoolsSourcePlugin,
} from "../domain.ts";
import { makeCommercetoolsSourceIdentityDefinitions } from "../domain.ts";
import { makeProjectedEntitySource } from "../internal/entity-source.ts";
import { ProductSourceSchema } from "../schemas.ts";
import { entitySourceBaseOptions } from "../selectors.ts";

export interface CommercetoolsProductSourceOptions
  extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "products";
}

export interface CommercetoolsProductSourceProjectionOptions<
  Source,
  SourceInput,
> extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "products";
  readonly projection: CommercetoolsSourceProjection<
    Source,
    SourceInput,
    Product
  >;
}

const productSourceDescriptor: CommercetoolsEntitySourceDescriptor<
  Product,
  ProductPagedQueryResponse
> = {
  getId: (product) => product.id,
  getKey: (product) => product.key,
  getVersion: (product) => product.version,
  identity: makeCommercetoolsSourceIdentityDefinitions({
    resource: "product",
    resourceLabel: "product",
  }),
  label: "Commercetools products",
  readById: (sdk, id) =>
    sdk.request("products.source.readById", (project) =>
      project.products().withId({ ID: id }).get()
    ),
  readByKey: (sdk, key) =>
    sdk.request("products.source.readByKey", (project) =>
      project.products().withKey({ key }).get()
    ),
  readPage: (sdk, queryArgs) =>
    sdk.request("products.source.read", (project) =>
      project.products().get({ queryArgs })
    ),
};

export function makeProductSource(
  options: CommercetoolsProductSourceOptions
): ConfiguredCommercetoolsSourcePlugin<Product, Product>;

export function makeProductSource<Source, SourceInput>(
  options: CommercetoolsProductSourceProjectionOptions<Source, SourceInput>
): ConfiguredCommercetoolsSourcePlugin<Source, SourceInput>;

export function makeProductSource<Source, SourceInput>(
  options:
    | CommercetoolsProductSourceOptions
    | CommercetoolsProductSourceProjectionOptions<Source, SourceInput>
): ConfiguredCommercetoolsSourcePlugin<
  Source | Product,
  SourceInput | Product
> {
  const baseOptions: CommercetoolsEntitySourceBaseOptions =
    entitySourceBaseOptions(options);

  return "projection" in options
    ? makeProjectedEntitySource(productSourceDescriptor, {
        ...baseOptions,
        select: options.projection.select,
        sourceSchema: options.projection.schema,
      })
    : makeProjectedEntitySource(productSourceDescriptor, {
        ...baseOptions,
        select: (product) => product,
        sourceSchema: ProductSourceSchema,
      });
}
