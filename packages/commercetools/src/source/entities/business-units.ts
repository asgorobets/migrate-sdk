import type {
  BusinessUnit,
  BusinessUnitPagedQueryResponse,
} from "@commercetools/platform-sdk";
import type {
  CommercetoolsEntitySourceBaseOptions,
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsSourceProjection,
  ConfiguredCommercetoolsSourcePlugin,
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
  Source,
  SourceInput,
> extends CommercetoolsEntitySourceBaseOptions {
  readonly entity: "businessUnits";
  readonly projection: CommercetoolsSourceProjection<
    Source,
    SourceInput,
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
): ConfiguredCommercetoolsSourcePlugin<BusinessUnit, BusinessUnit>;

export function makeBusinessUnitSource<Source, SourceInput>(
  options: CommercetoolsBusinessUnitSourceProjectionOptions<Source, SourceInput>
): ConfiguredCommercetoolsSourcePlugin<Source, SourceInput>;

export function makeBusinessUnitSource<Source, SourceInput>(
  options:
    | CommercetoolsBusinessUnitSourceOptions
    | CommercetoolsBusinessUnitSourceProjectionOptions<Source, SourceInput>
): ConfiguredCommercetoolsSourcePlugin<
  Source | BusinessUnit,
  SourceInput | BusinessUnit
> {
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
