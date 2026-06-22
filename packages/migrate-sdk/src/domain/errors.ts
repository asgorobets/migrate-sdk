import { Schema } from "effect";

const ErrorFields = {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
};

export class SourceError extends Schema.TaggedErrorClass<SourceError>()(
  "SourceError",
  ErrorFields
) {}

export class DestinationError extends Schema.TaggedErrorClass<DestinationError>()(
  "DestinationError",
  ErrorFields
) {}

export class MigrationStoreError extends Schema.TaggedErrorClass<MigrationStoreError>()(
  "MigrationStoreError",
  ErrorFields
) {}

export class MigrationReferenceLookupError extends Schema.TaggedErrorClass<MigrationReferenceLookupError>()(
  "MigrationReferenceLookupError",
  ErrorFields
) {}

export class MigrationRuntimeError extends Schema.TaggedErrorClass<MigrationRuntimeError>()(
  "MigrationRuntimeError",
  ErrorFields
) {}

export class RollbackRequestError extends Schema.TaggedErrorClass<RollbackRequestError>()(
  "RollbackRequestError",
  ErrorFields
) {}

export class RollbackPreflightError extends Schema.TaggedErrorClass<RollbackPreflightError>()(
  "RollbackPreflightError",
  ErrorFields
) {}

export class SkipItem extends Schema.TaggedErrorClass<SkipItem>()("SkipItem", {
  reason: Schema.String,
}) {}

export const makeSkipItem = (reason: string) => new SkipItem({ reason });

export const skipItem = makeSkipItem;
