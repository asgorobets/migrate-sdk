import { Schema } from "effect";

/** A durable reference. Bytes and storage clients stay outside migration state. */
export const FilesSDKObject = Schema.Struct({
  storageId: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  contentType: Schema.String,
  etag: Schema.optional(Schema.NonEmptyString),
  lastModified: Schema.optional(Schema.Finite),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type FilesSDKObject = typeof FilesSDKObject.Type;
