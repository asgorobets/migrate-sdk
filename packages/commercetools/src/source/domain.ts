import type { Effect } from "effect";
import { Schema } from "effect";
import {
  type ConfiguredSourcePlugin,
  SourceIdentity,
  type SourceIdentityDefinition,
  type SourcePayloadSchema,
} from "migrate-sdk";
import type { CommercetoolsSdk, CommercetoolsSdkError } from "../sdk.ts";
import type { CommercetoolsSourceCursor } from "./schemas.ts";

export type CommercetoolsSourceIdentity = "id" | "key";

export type CommercetoolsSourceIdentityKey = string;

export interface CommercetoolsEntitySourceIdentityDefinitions {
  readonly id: SourceIdentityDefinition<CommercetoolsSourceIdentityKey>;
  readonly key: SourceIdentityDefinition<CommercetoolsSourceIdentityKey>;
}

const sourceIdentitySchema = (partName: string) =>
  SourceIdentity.key(partName, Schema.String);

export const makeCommercetoolsSourceIdentityDefinitions = (input: {
  readonly resource: string;
  readonly resourceLabel: string;
}): CommercetoolsEntitySourceIdentityDefinitions => ({
  id: SourceIdentity.make({
    id: `commercetools-${input.resource}-id@v1`,
    schema: sourceIdentitySchema(`${input.resourceLabel}Id`),
  }),
  key: SourceIdentity.make({
    id: `commercetools-${input.resource}-key@v1`,
    schema: sourceIdentitySchema(`${input.resourceLabel}Key`),
  }),
});

export type CommercetoolsSourceQueryVariableValue =
  | boolean
  | number
  | string
  | readonly boolean[]
  | readonly number[]
  | readonly string[];

export type CommercetoolsSourceWhereVariables = Readonly<
  Record<string, CommercetoolsSourceQueryVariableValue>
>;

export interface CommercetoolsEntitySourceBaseOptions {
  readonly batchSize?: number;
  readonly expand?: string | readonly string[];
  readonly identity?: CommercetoolsSourceIdentity;
  readonly where?: string | readonly string[];
  readonly whereVariables?: CommercetoolsSourceWhereVariables;
}

export interface CommercetoolsSourceProjection<Source, SourceInput, Resource> {
  readonly schema: SourcePayloadSchema<Source, SourceInput>;
  readonly select: (resource: Resource) => SourceInput;
}

export interface CommercetoolsProjectedEntitySourceOptions<
  Source,
  SourceInput,
  Resource,
> extends CommercetoolsEntitySourceBaseOptions {
  readonly select: (resource: Resource) => SourceInput;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
}

export interface CommercetoolsSourceQueryArgs {
  readonly expand?: string | string[];
  readonly limit: number;
  readonly sort: string;
  readonly "var.lastId"?: string;
  readonly where?: string | string[];
  readonly withTotal: false;
  readonly [key: string]:
    | boolean
    | boolean[]
    | number
    | number[]
    | string
    | string[]
    | undefined;
}

export interface CommercetoolsSourceCountQueryArgs {
  readonly limit: number;
  readonly where?: string | string[];
  readonly withTotal: true;
  readonly [key: string]:
    | boolean
    | boolean[]
    | number
    | number[]
    | string
    | string[]
    | undefined;
}

export interface CommercetoolsPagedQueryResponse<Resource> {
  readonly results: readonly Resource[];
  readonly total?: number | undefined;
}

export interface CommercetoolsEntitySourceDescriptor<
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
> {
  readonly countPage: (
    sdk: typeof CommercetoolsSdk.Service,
    queryArgs: CommercetoolsSourceCountQueryArgs
  ) => Effect.Effect<Page, CommercetoolsSdkError>;
  readonly getId: (resource: Resource) => string;
  readonly getKey: (resource: Resource) => string | undefined;
  readonly getVersion: (resource: Resource) => number;
  readonly identity: CommercetoolsEntitySourceIdentityDefinitions;
  readonly label: string;
  readonly readById: (
    sdk: typeof CommercetoolsSdk.Service,
    id: string
  ) => Effect.Effect<Resource, CommercetoolsSdkError>;
  readonly readByKey: (
    sdk: typeof CommercetoolsSdk.Service,
    key: string
  ) => Effect.Effect<Resource, CommercetoolsSdkError>;
  readonly readPage: (
    sdk: typeof CommercetoolsSdk.Service,
    queryArgs: CommercetoolsSourceQueryArgs
  ) => Effect.Effect<Page, CommercetoolsSdkError>;
}

export type ConfiguredCommercetoolsSourcePlugin<Source, SourceInput> =
  ConfiguredSourcePlugin<
    Source,
    CommercetoolsSourceCursor,
    CommercetoolsSourceIdentityKey,
    SourceInput,
    never,
    CommercetoolsSdk
  >;
