import { SourceError } from "../../../domain/errors.ts";
import type { EncodedSourceIdentityInput } from "../../../domain/ids.ts";

export type SqlSourceOperation = "count" | "read" | "readByIdentity";

export const makeSqlSourceBatchSizeError = (batchSize: number): SourceError =>
  new SourceError({
    cause: { batchSize },
    message: "SQL source batchSize must be a positive integer",
  });

export const makeSqlSourceExecutionError = (
  operation: SqlSourceOperation,
  cause: unknown
): SourceError =>
  new SourceError({
    cause,
    message: `SQL source ${operation} failed`,
  });

export const makeSqlSourceLookupMultipleRowsError = (
  identity: EncodedSourceIdentityInput,
  rowCount: number
): SourceError =>
  new SourceError({
    cause: {
      rowCount,
      sourceIdentity: identity,
    },
    message: "SQL source readByIdentity returned multiple rows",
  });

export const makeSqlSourceLookupIdentityMismatchError = (
  requestedIdentity: EncodedSourceIdentityInput,
  returnedIdentity: EncodedSourceIdentityInput
): SourceError =>
  new SourceError({
    cause: {
      requestedSourceIdentity: requestedIdentity,
      returnedSourceIdentity: returnedIdentity,
    },
    message: "SQL source readByIdentity returned a different Source Identity",
  });

export const makeSqlSourceMetadataError = (
  operation: SqlSourceOperation,
  rowIndex: number,
  message: string,
  cause?: unknown
): SourceError =>
  new SourceError({
    ...(cause === undefined ? {} : { cause }),
    message: `SQL source ${operation} metadata failed for row ${rowIndex}: ${message}`,
  });
