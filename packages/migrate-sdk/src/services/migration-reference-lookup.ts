import type { Effect } from "effect";
import { Service } from "effect/Context";
import type {
  DestinationPluginError,
  MigrationReferenceLookupError,
  MigrationStoreError,
} from "../domain/errors.ts";
import type {
  EncodedSourceIdentity,
  MigrationDefinitionId,
} from "../domain/ids.ts";
import type {
  AnyMigrationDefinition,
  MigrationDefinitionSourceIdentityKey,
  MigrationDefinitionTrackingContract,
  MigrationDefinitionTrackingRecord,
} from "../domain/run.ts";
import type {
  TrackingRecord,
  TrackingRecordContract,
} from "../domain/tracking.ts";

const migrationReferenceLookupTargetTypeId: unique symbol = Symbol.for(
  "@migrate-sdk/MigrationReferenceLookupTarget"
);

export interface MigrationReferenceBase {
  readonly definitionId: MigrationDefinitionId;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly status: "migrated" | "needs-update";
}

export interface MigrationReference<
  Record extends TrackingRecord = TrackingRecord,
> extends MigrationReferenceBase {
  readonly trackingRecord: Record;
}

export type MigrationReferenceForDefinition<
  Definition extends AnyMigrationDefinition,
> =
  MigrationDefinitionTrackingContract<Definition> extends TrackingRecordContract
    ? MigrationReference<MigrationDefinitionTrackingRecord<Definition>>
    : never;

export type MigrationReferenceLookupStubInput<
  Definition extends AnyMigrationDefinition,
> =
  | boolean
  | {
      readonly definition?: Definition;
    };

export interface MigrationReferenceLookupTarget<
  Definition extends AnyMigrationDefinition,
> {
  readonly definition: Definition;
  readonly sourceIdentityKey: MigrationDefinitionSourceIdentityKey<Definition>;
  readonly [migrationReferenceLookupTargetTypeId]: Definition;
}

export type MigrationReferenceLookupTargetSet = readonly [
  MigrationReferenceLookupTarget<AnyMigrationDefinition>,
  ...MigrationReferenceLookupTarget<AnyMigrationDefinition>[],
];

export const makeMigrationReferenceLookupTarget = <
  Definition extends AnyMigrationDefinition,
>(
  definition: Definition,
  sourceIdentityKey: MigrationDefinitionSourceIdentityKey<Definition>
): MigrationReferenceLookupTarget<Definition> => ({
  definition,
  sourceIdentityKey,
  [migrationReferenceLookupTargetTypeId]: definition,
});

export interface MigrationReferenceLookupSingleInput<
  Definition extends AnyMigrationDefinition,
> {
  readonly definition: Definition;
  readonly definitions?: never;
  readonly sourceIdentityKey: MigrationDefinitionSourceIdentityKey<Definition>;
  readonly stub?: MigrationReferenceLookupStubInput<Definition>;
  readonly targets?: never;
}

export interface MigrationReferenceLookupTargetsInput<
  Targets extends MigrationReferenceLookupTargetSet,
> {
  readonly definition?: never;
  readonly definitions?: never;
  readonly sourceIdentityKey?: never;
  readonly stub?:
    | boolean
    | {
        readonly definition?: Targets[number]["definition"];
      };
  readonly targets: Targets;
}

export type MigrationReferenceLookupInput<
  Definition extends AnyMigrationDefinition,
> =
  | MigrationReferenceLookupSingleInput<Definition>
  | MigrationReferenceLookupTargetsInput<MigrationReferenceLookupTargetSet>;

export type AnyMigrationReferenceLookupInput =
  MigrationReferenceLookupInput<AnyMigrationDefinition>;

type MigrationReferenceLookupEffect<
  Reference extends MigrationReference = MigrationReference,
> = Effect.Effect<
  Reference | null,
  DestinationPluginError | MigrationReferenceLookupError | MigrationStoreError
>;

export interface MigrationReferenceLookupService {
  readonly lookup: {
    <Definition extends AnyMigrationDefinition>(
      input: MigrationReferenceLookupSingleInput<Definition>
    ): MigrationReferenceLookupEffect<
      MigrationReferenceForDefinition<Definition>
    >;
    <const Targets extends MigrationReferenceLookupTargetSet>(
      input: MigrationReferenceLookupTargetsInput<Targets>
    ): MigrationReferenceLookupEffect<
      MigrationReferenceForDefinition<Targets[number]["definition"]>
    >;
  };
  readonly target: <Definition extends AnyMigrationDefinition>(
    definition: Definition,
    sourceIdentityKey: MigrationDefinitionSourceIdentityKey<Definition>
  ) => MigrationReferenceLookupTarget<Definition>;
}

export class MigrationReferenceLookup extends Service<
  MigrationReferenceLookup,
  MigrationReferenceLookupService
>()("@migrate-sdk/MigrationReferenceLookup") {}
