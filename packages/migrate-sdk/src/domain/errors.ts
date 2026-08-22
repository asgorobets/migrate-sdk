import { Schema } from "effect";

const ErrorFields = {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
};

export class SourceError extends Schema.TaggedError<SourceError>()(
  "SourceError",
  ErrorFields
) {}

export class DestinationError extends Schema.TaggedError<DestinationError>()(
  "DestinationError",
  ErrorFields
) {}

export class MigrationStoreError extends Schema.TaggedError<MigrationStoreError>()(
  "MigrationStoreError",
  ErrorFields
) {}

export class MigrationReferenceLookupError extends Schema.TaggedError<MigrationReferenceLookupError>()(
  "MigrationReferenceLookupError",
  ErrorFields
) {}

export class MigrationRuntimeError extends Schema.TaggedError<MigrationRuntimeError>()(
  "MigrationRuntimeError",
  ErrorFields
) {}

export class RollbackRequestError extends Schema.TaggedError<RollbackRequestError>()(
  "RollbackRequestError",
  ErrorFields
) {}

export class RollbackPreflightError extends Schema.TaggedError<RollbackPreflightError>()(
  "RollbackPreflightError",
  ErrorFields
) {}

export class SkipItem extends Schema.TaggedError<SkipItem>()("SkipItem", {
  reason: Schema.String,
}) {}

export const makeSkipItem = (reason: string) => new SkipItem({ reason });

export const skipItem = makeSkipItem;
