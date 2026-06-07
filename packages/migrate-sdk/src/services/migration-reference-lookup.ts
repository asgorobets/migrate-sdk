import type { Effect } from "effect";
import { Service } from "effect/Context";
import type {
  DestinationPluginError,
  MigrationReferenceLookupError,
  MigrationStoreError,
} from "../domain/errors.ts";
import type {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
  SourceIdentity,
  SourceIdentityInput,
} from "../domain/ids.ts";

export interface MigrationReference {
  readonly definitionId: MigrationDefinitionId;
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly sourceIdentity: SourceIdentity;
  readonly status: "migrated" | "needs-update";
}

export type MigrationReferenceLookupInput =
  | {
      readonly definitionId: MigrationDefinitionIdInput;
      readonly definitionIds?: never;
      readonly sourceIdentity: SourceIdentityInput;
      readonly stub?:
        | boolean
        | {
            readonly definitionId?: MigrationDefinitionIdInput;
          };
    }
  | {
      readonly definitionId?: never;
      readonly definitionIds: readonly MigrationDefinitionIdInput[];
      readonly sourceIdentity: SourceIdentityInput;
      readonly stub?:
        | boolean
        | {
            readonly definitionId?: MigrationDefinitionIdInput;
          };
    };

export class MigrationReferenceLookup extends Service<
  MigrationReferenceLookup,
  {
    readonly lookup: (
      input: MigrationReferenceLookupInput
    ) => Effect.Effect<
      MigrationReference | null,
      | DestinationPluginError
      | MigrationReferenceLookupError
      | MigrationStoreError
    >;
  }
>()("@migrate-sdk/MigrationReferenceLookup") {}
