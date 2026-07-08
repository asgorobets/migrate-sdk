import type {
  BusinessUnit,
  Customer,
  Product,
} from "@commercetools/platform-sdk";
import type { ConfiguredSource } from "migrate-sdk";
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

type ConfiguredCommercetoolsSource<Payload, EncodedPayload> = ConfiguredSource<
  Payload,
  CommercetoolsSourceCursor,
  string,
  EncodedPayload,
  never,
  CommercetoolsSdk
>;

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
  Payload,
  EncodedPayload,
> = WithoutEntity<
  CommercetoolsBusinessUnitSourceProjectionOptions<Payload, EncodedPayload>
>;

export type CommercetoolsCustomerSourceFactoryOptions =
  WithoutEntity<CommercetoolsCustomerSourceOptions>;

export type CommercetoolsCustomerSourceProjectionFactoryOptions<
  Payload,
  EncodedPayload,
> = WithoutEntity<
  CommercetoolsCustomerSourceProjectionOptions<Payload, EncodedPayload>
>;

export type CommercetoolsProductSourceFactoryOptions =
  WithoutEntity<CommercetoolsProductSourceOptions>;

export type CommercetoolsProductSourceProjectionFactoryOptions<
  Payload,
  EncodedPayload,
> = WithoutEntity<
  CommercetoolsProductSourceProjectionOptions<Payload, EncodedPayload>
>;

export interface CommercetoolsSourceFactory {
  readonly businessUnits: {
    <Payload, EncodedPayload>(
      options: CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
        Payload,
        EncodedPayload
      >
    ): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;
    (
      options?: CommercetoolsBusinessUnitSourceFactoryOptions
    ): ConfiguredCommercetoolsSource<BusinessUnit, BusinessUnit>;
  };
  readonly customers: {
    <Payload, EncodedPayload>(
      options: CommercetoolsCustomerSourceProjectionFactoryOptions<
        Payload,
        EncodedPayload
      >
    ): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;
    (
      options?: CommercetoolsCustomerSourceFactoryOptions
    ): ConfiguredCommercetoolsSource<Customer, Customer>;
  };
  readonly products: {
    <Payload, EncodedPayload>(
      options: CommercetoolsProductSourceProjectionFactoryOptions<
        Payload,
        EncodedPayload
      >
    ): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;
    (
      options?: CommercetoolsProductSourceFactoryOptions
    ): ConfiguredCommercetoolsSource<Product, Product>;
  };
}

function businessUnits<Payload, EncodedPayload>(
  options: CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
    Payload,
    EncodedPayload
  >
): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;

function businessUnits(
  options?: CommercetoolsBusinessUnitSourceFactoryOptions
): ConfiguredCommercetoolsSource<BusinessUnit, BusinessUnit>;

function businessUnits<Payload, EncodedPayload>(
  options:
    | CommercetoolsBusinessUnitSourceFactoryOptions
    | CommercetoolsBusinessUnitSourceProjectionFactoryOptions<
        Payload,
        EncodedPayload
      > = {}
) {
  return makeBusinessUnitSource({
    ...options,
    entity: "businessUnits",
  } as
    | CommercetoolsBusinessUnitSourceOptions
    | CommercetoolsBusinessUnitSourceProjectionOptions<
        Payload,
        EncodedPayload
      >);
}

function customers<Payload, EncodedPayload>(
  options: CommercetoolsCustomerSourceProjectionFactoryOptions<
    Payload,
    EncodedPayload
  >
): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;

function customers(
  options?: CommercetoolsCustomerSourceFactoryOptions
): ConfiguredCommercetoolsSource<Customer, Customer>;

function customers<Payload, EncodedPayload>(
  options:
    | CommercetoolsCustomerSourceFactoryOptions
    | CommercetoolsCustomerSourceProjectionFactoryOptions<
        Payload,
        EncodedPayload
      > = {}
) {
  return makeCustomerSource({
    ...options,
    entity: "customers",
  } as
    | CommercetoolsCustomerSourceOptions
    | CommercetoolsCustomerSourceProjectionOptions<Payload, EncodedPayload>);
}

function products<Payload, EncodedPayload>(
  options: CommercetoolsProductSourceProjectionFactoryOptions<
    Payload,
    EncodedPayload
  >
): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;

function products(
  options?: CommercetoolsProductSourceFactoryOptions
): ConfiguredCommercetoolsSource<Product, Product>;

function products<Payload, EncodedPayload>(
  options:
    | CommercetoolsProductSourceFactoryOptions
    | CommercetoolsProductSourceProjectionFactoryOptions<
        Payload,
        EncodedPayload
      > = {}
) {
  return makeProductSource({
    ...options,
    entity: "products",
  } as
    | CommercetoolsProductSourceOptions
    | CommercetoolsProductSourceProjectionOptions<Payload, EncodedPayload>);
}

export const CommercetoolsSource: CommercetoolsSourceFactory = {
  businessUnits,
  customers,
  products,
};
