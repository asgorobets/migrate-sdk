import type {
  Customer,
  CustomerPagedQueryResponse,
} from "@commercetools/platform-sdk";
import type {
  CommercetoolsEntitySourceBaseOptions,
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsSourceProjection,
  ConfiguredCommercetoolsSource,
} from "../domain.ts";
import { makeCommercetoolsSourceIdentityDefinitions } from "../domain.ts";
import { makeProjectedEntitySource } from "../internal/entity-source.ts";
import { CustomerSourceSchema } from "../schemas.ts";
import { entitySourceBaseOptions } from "../selectors.ts";

export interface CommercetoolsCustomerSourceOptions
  extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "customers";
}

export interface CommercetoolsCustomerSourceProjectionOptions<
  Source,
  SourceInput,
> extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "customers";
  readonly projection: CommercetoolsSourceProjection<
    Source,
    SourceInput,
    Customer
  >;
}

const customerSourceDescriptor: CommercetoolsEntitySourceDescriptor<
  Customer,
  CustomerPagedQueryResponse
> = {
  getId: (customer) => customer.id,
  getKey: (customer) => customer.key,
  getVersion: (customer) => customer.version,
  identity: makeCommercetoolsSourceIdentityDefinitions({
    resource: "customer",
    resourceLabel: "customer",
  }),
  label: "Commercetools customers",
  countPage: (sdk, queryArgs) =>
    sdk.request("customers.source.count", (project) =>
      project.customers().get({ queryArgs })
    ),
  readById: (sdk, id) =>
    sdk.request("customers.source.readById", (project) =>
      project.customers().withId({ ID: id }).get()
    ),
  readByKey: (sdk, key) =>
    sdk.request("customers.source.readByKey", (project) =>
      project.customers().withKey({ key }).get()
    ),
  readPage: (sdk, queryArgs) =>
    sdk.request("customers.source.read", (project) =>
      project.customers().get({ queryArgs })
    ),
};

export function makeCustomerSource(
  options: CommercetoolsCustomerSourceOptions
): ConfiguredCommercetoolsSource<Customer, Customer>;

export function makeCustomerSource<Source, SourceInput>(
  options: CommercetoolsCustomerSourceProjectionOptions<Source, SourceInput>
): ConfiguredCommercetoolsSource<Source, SourceInput>;

export function makeCustomerSource<Source, SourceInput>(
  options:
    | CommercetoolsCustomerSourceOptions
    | CommercetoolsCustomerSourceProjectionOptions<Source, SourceInput>
): ConfiguredCommercetoolsSource<Source | Customer, SourceInput | Customer> {
  const baseOptions: CommercetoolsEntitySourceBaseOptions =
    entitySourceBaseOptions(options);

  return "projection" in options
    ? makeProjectedEntitySource(customerSourceDescriptor, {
        ...baseOptions,
        select: options.projection.select,
        sourceSchema: options.projection.schema,
      })
    : makeProjectedEntitySource(customerSourceDescriptor, {
        ...baseOptions,
        select: (customer) => customer,
        sourceSchema: CustomerSourceSchema,
      });
}
