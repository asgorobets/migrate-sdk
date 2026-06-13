import type { Effect } from "effect";
import type { ConfiguredSourcePlugin, SourcePayloadSchema } from "migrate-sdk";
import type { CommercetoolsSdk, CommercetoolsSdkError } from "../sdk.ts";
import type { CommercetoolsSourceCursor } from "./schemas.ts";

export type CommercetoolsSourceIdentity = "id" | "key";

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

export interface CommercetoolsPagedQueryResponse<Resource> {
  readonly results: readonly Resource[];
}

export interface CommercetoolsEntitySourceDescriptor<
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
> {
  readonly getId: (resource: Resource) => string;
  readonly getKey: (resource: Resource) => string | undefined;
  readonly getVersion: (resource: Resource) => number;
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
    SourceInput,
    never,
    CommercetoolsSdk
  >;
