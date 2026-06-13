import type {
  BusinessUnit,
  Customer,
  Product,
} from "@commercetools/platform-sdk";
import type { ConfiguredSourcePlugin } from "migrate-sdk";
import type { CommercetoolsSdk } from "../sdk.ts";
import {
  type CommercetoolsBusinessUnitSourceOptions,
  type CommercetoolsBusinessUnitSourceProjectionOptions,
  makeBusinessUnitSource,
} from "./entities/business-units.ts";
import {
  type CommercetoolsCustomerSourceOptions,
  type CommercetoolsCustomerSourceProjectionOptions,
  makeCustomerSource,
} from "./entities/customers.ts";
import {
  type CommercetoolsProductSourceOptions,
  type CommercetoolsProductSourceProjectionOptions,
  makeProductSource,
} from "./entities/products.ts";
import type { CommercetoolsSourceCursor } from "./schemas.ts";

export type {
  CommercetoolsSourceIdentity,
  CommercetoolsSourceQueryVariableValue,
  CommercetoolsSourceWhereVariables,
} from "./domain.ts";
export type {
  CommercetoolsBusinessUnitSourceOptions,
  CommercetoolsBusinessUnitSourceProjectionOptions,
} from "./entities/business-units.ts";
export type {
  CommercetoolsCustomerSourceOptions,
  CommercetoolsCustomerSourceProjectionOptions,
} from "./entities/customers.ts";
export type {
  CommercetoolsProductSourceOptions,
  CommercetoolsProductSourceProjectionOptions,
} from "./entities/products.ts";
export type { CommercetoolsSourceCursor } from "./schemas.ts";

type WithoutEntity<Options extends { readonly entity: string }> = Omit<
  Options,
  "entity"
>;

export type CommercetoolsBusinessUnitSourceFactoryOptions =
  WithoutEntity<CommercetoolsBusinessUnitSourceOptions>;

export type CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
  Source,
  SourceInput,
> = WithoutEntity<
  CommercetoolsBusinessUnitSourceProjectionOptions<Source, SourceInput>
>;

export type CommercetoolsCustomerSourceFactoryOptions =
  WithoutEntity<CommercetoolsCustomerSourceOptions>;

export type CommercetoolsCustomerSourceProjectionFactoryOptions<
  Source,
  SourceInput,
> = WithoutEntity<
  CommercetoolsCustomerSourceProjectionOptions<Source, SourceInput>
>;

export type CommercetoolsProductSourceFactoryOptions =
  WithoutEntity<CommercetoolsProductSourceOptions>;

export type CommercetoolsProductSourceProjectionFactoryOptions<
  Source,
  SourceInput,
> = WithoutEntity<
  CommercetoolsProductSourceProjectionOptions<Source, SourceInput>
>;

export interface CommercetoolsSourcePluginFactory {
  readonly businessUnits: {
    <Source, SourceInput>(
      options: CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
        Source,
        SourceInput
      >
    ): ConfiguredSourcePlugin<
      Source,
      CommercetoolsSourceCursor,
      SourceInput,
      never,
      CommercetoolsSdk
    >;
    (
      options?: CommercetoolsBusinessUnitSourceFactoryOptions
    ): ConfiguredSourcePlugin<
      BusinessUnit,
      CommercetoolsSourceCursor,
      BusinessUnit,
      never,
      CommercetoolsSdk
    >;
  };
  readonly customers: {
    <Source, SourceInput>(
      options: CommercetoolsCustomerSourceProjectionFactoryOptions<
        Source,
        SourceInput
      >
    ): ConfiguredSourcePlugin<
      Source,
      CommercetoolsSourceCursor,
      SourceInput,
      never,
      CommercetoolsSdk
    >;
    (
      options?: CommercetoolsCustomerSourceFactoryOptions
    ): ConfiguredSourcePlugin<
      Customer,
      CommercetoolsSourceCursor,
      Customer,
      never,
      CommercetoolsSdk
    >;
  };
  readonly products: {
    <Source, SourceInput>(
      options: CommercetoolsProductSourceProjectionFactoryOptions<
        Source,
        SourceInput
      >
    ): ConfiguredSourcePlugin<
      Source,
      CommercetoolsSourceCursor,
      SourceInput,
      never,
      CommercetoolsSdk
    >;
    (
      options?: CommercetoolsProductSourceFactoryOptions
    ): ConfiguredSourcePlugin<
      Product,
      CommercetoolsSourceCursor,
      Product,
      never,
      CommercetoolsSdk
    >;
  };
}

function businessUnits<Source, SourceInput>(
  options: CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
    Source,
    SourceInput
  >
): ConfiguredSourcePlugin<
  Source,
  CommercetoolsSourceCursor,
  SourceInput,
  never,
  CommercetoolsSdk
>;

function businessUnits(
  options?: CommercetoolsBusinessUnitSourceFactoryOptions
): ConfiguredSourcePlugin<
  BusinessUnit,
  CommercetoolsSourceCursor,
  BusinessUnit,
  never,
  CommercetoolsSdk
>;

function businessUnits<Source, SourceInput>(
  options:
    | CommercetoolsBusinessUnitSourceFactoryOptions
    | CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
        Source,
        SourceInput
      > = {}
) {
  return makeBusinessUnitSource({
    ...options,
    entity: "businessUnits",
  } as
    | CommercetoolsBusinessUnitSourceOptions
    | CommercetoolsBusinessUnitSourceProjectionOptions<Source, SourceInput>);
}

function customers<Source, SourceInput>(
  options: CommercetoolsCustomerSourceProjectionFactoryOptions<
    Source,
    SourceInput
  >
): ConfiguredSourcePlugin<
  Source,
  CommercetoolsSourceCursor,
  SourceInput,
  never,
  CommercetoolsSdk
>;

function customers(
  options?: CommercetoolsCustomerSourceFactoryOptions
): ConfiguredSourcePlugin<
  Customer,
  CommercetoolsSourceCursor,
  Customer,
  never,
  CommercetoolsSdk
>;

function customers<Source, SourceInput>(
  options:
    | CommercetoolsCustomerSourceFactoryOptions
    | CommercetoolsCustomerSourceProjectionFactoryOptions<
        Source,
        SourceInput
      > = {}
) {
  return makeCustomerSource({
    ...options,
    entity: "customers",
  } as
    | CommercetoolsCustomerSourceOptions
    | CommercetoolsCustomerSourceProjectionOptions<Source, SourceInput>);
}

function products<Source, SourceInput>(
  options: CommercetoolsProductSourceProjectionFactoryOptions<
    Source,
    SourceInput
  >
): ConfiguredSourcePlugin<
  Source,
  CommercetoolsSourceCursor,
  SourceInput,
  never,
  CommercetoolsSdk
>;

function products(
  options?: CommercetoolsProductSourceFactoryOptions
): ConfiguredSourcePlugin<
  Product,
  CommercetoolsSourceCursor,
  Product,
  never,
  CommercetoolsSdk
>;

function products<Source, SourceInput>(
  options:
    | CommercetoolsProductSourceFactoryOptions
    | CommercetoolsProductSourceProjectionFactoryOptions<
        Source,
        SourceInput
      > = {}
) {
  return makeProductSource({
    ...options,
    entity: "products",
  } as
    | CommercetoolsProductSourceOptions
    | CommercetoolsProductSourceProjectionOptions<Source, SourceInput>);
}

export const CommercetoolsSourcePlugin: CommercetoolsSourcePluginFactory = {
  businessUnits,
  customers,
  products,
};
