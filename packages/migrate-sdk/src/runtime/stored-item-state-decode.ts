import { Effect, Schema } from "effect";
import {
  makeMigrationItemStateWithTrackingRecordSchema,
  type MigrationItemError,
  type MigrationItemState,
  type MigrationItemStateForTrackingContract,
  type MigrationItemStateWithTrackingRecord,
} from "../domain/state.ts";
import type {
  TrackingRecordContract,
  TrackingRecordValue,
} from "../domain/tracking.ts";
import { normalizeTrackingRecordSchemaError } from "./item-error.ts";

const decodeStoredItemStateWithTrackingRecord = <
  Value extends TrackingRecordValue,
  Encoded extends TrackingRecordValue,
>(
  itemState: MigrationItemState,
  contract: TrackingRecordContract<Value, Encoded>
): Effect.Effect<
  MigrationItemStateWithTrackingRecord<Value>,
  MigrationItemError
> => {
  const itemStateSchema = makeMigrationItemStateWithTrackingRecordSchema(
    contract.schema
  );

  return Schema.decodeUnknownEffect(itemStateSchema, { errors: "all" })(
    itemState
  ).pipe(
    Effect.mapError((error) =>
      normalizeTrackingRecordSchemaError(contract, error)
    )
  );
};

export const decodeStoredItemStateForTrackingContract = <
  TrackingContract extends TrackingRecordContract | undefined,
>(
  itemState: MigrationItemState,
  tracking: TrackingRecordContract | undefined
): Effect.Effect<
  MigrationItemStateForTrackingContract<TrackingContract>,
  MigrationItemError
> =>
  (
    tracking === undefined
      ? Effect.succeed(itemState)
      : decodeStoredItemStateWithTrackingRecord(itemState, tracking)
  ) as Effect.Effect<
    MigrationItemStateForTrackingContract<TrackingContract>,
    MigrationItemError
  >;
