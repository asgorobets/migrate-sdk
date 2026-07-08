import type {
  BusinessUnit,
  BusinessUnitPagedQueryResponse,
} from "@commercetools/platform-sdk";
import type {
  CommercetoolsEntitySourceBaseOptions,
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsSourceProjection,
  ConfiguredCommercetoolsSource,
} from "../domain.ts";
import { makeCommercetoolsSourceIdentityDefinitions } from "../domain.ts";
import { makeProjectedEntitySource } from "../internal/entity-source.ts";
import { BusinessUnitSourceSchema } from "../schemas.ts";
import { entitySourceBaseOptions } from "../selectors.ts";

export interface CommercetoolsBusinessUnitSourceOptions
  extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "businessUnits";
}

export interface CommercetoolsBusinessUnitSourceProjectionOptions<
  Payload,
  EncodedPayload,
> extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "businessUnits";
  readonly projection: CommercetoolsSourceProjection<
    Payload,
    EncodedPayload,
    BusinessUnit
  >;
}

const businessUnitSourceDescriptor: CommercetoolsEntitySourceDescriptor<
  BusinessUnit,
  BusinessUnitPagedQueryResponse
> = {
  getId: (businessUnit) => businessUnit.id,
  getKey: (businessUnit) => businessUnit.key,
  getVersion: (businessUnit) => businessUnit.version,
  identity: makeCommercetoolsSourceIdentityDefinitions({
    resource: "business-unit",
    resourceLabel: "businessUnit",
  }),
  label: "Commercetools business units",
  countPage: (sdk, queryArgs) =>
    sdk.request("businessUnits.source.count", (project) =>
      project.businessUnits().get({ queryArgs })
    ),
  readById: (sdk, id) =>
    sdk.request("businessUnits.source.readById", (project) =>
      project.businessUnits().withId({ ID: id }).get()
    ),
  readByKey: (sdk, key) =>
    sdk.request("businessUnits.source.readByKey", (project) =>
      project.businessUnits().withKey({ key }).get()
    ),
  readPage: (sdk, queryArgs) =>
    sdk.request("businessUnits.source.read", (project) =>
      project.businessUnits().get({ queryArgs })
    ),
};

export function makeBusinessUnitSource(
  options: CommercetoolsBusinessUnitSourceOptions
): ConfiguredCommercetoolsSource<BusinessUnit, BusinessUnit>;

export function makeBusinessUnitSource<Payload, EncodedPayload>(
  options: CommercetoolsBusinessUnitSourceProjectionOptions<
    Payload,
    EncodedPayload
  >
): ConfiguredCommercetoolsSource<Payload, EncodedPayload>;

export function makeBusinessUnitSource<Payload, EncodedPayload>(
  options:
    | CommercetoolsBusinessUnitSourceOptions
    | CommercetoolsBusinessUnitSourceProjectionOptions<Payload, EncodedPayload>
):
  | ConfiguredCommercetoolsSource<BusinessUnit, BusinessUnit>
  | ConfiguredCommercetoolsSource<Payload, EncodedPayload> {
  const baseOptions: CommercetoolsEntitySourceBaseOptions =
    entitySourceBaseOptions(options);

  return "projection" in options
    ? makeProjectedEntitySource(businessUnitSourceDescriptor, {
        ...baseOptions,
        select: options.projection.select,
        sourceSchema: options.projection.schema,
      })
    : makeProjectedEntitySource(businessUnitSourceDescriptor, {
        ...baseOptions,
        select: (businessUnit) => businessUnit,
        sourceSchema: BusinessUnitSourceSchema,
      });
}
