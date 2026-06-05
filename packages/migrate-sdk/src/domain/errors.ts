import { Schema } from "effect";

const ErrorFields = {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
};

export class SourcePluginError extends Schema.TaggedErrorClass<SourcePluginError>()(
  "SourcePluginError",
  ErrorFields
) {}

export class DestinationPluginError extends Schema.TaggedErrorClass<DestinationPluginError>()(
  "DestinationPluginError",
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

export class SkipItem extends Schema.TaggedErrorClass<SkipItem>()("SkipItem", {
  reason: Schema.String,
}) {}

export const makeSkipItem = (reason: string) => new SkipItem({ reason });

export const skipItem = makeSkipItem;
