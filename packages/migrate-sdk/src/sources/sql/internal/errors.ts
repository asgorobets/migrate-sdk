import { SourcePluginError } from "../../../domain/errors.ts";
import type { SourceIdentityInput } from "../../../domain/ids.ts";

export type SqlSourceOperation = "read" | "readByIdentity";

export const makeSqlSourceBatchSizeError = (
  batchSize: number
): SourcePluginError =>
  new SourcePluginError({
    cause: { batchSize },
    message: "SQL source plugin batchSize must be a positive integer",
  });

export const makeSqlSourceExecutionError = (
  operation: SqlSourceOperation,
  cause: unknown
): SourcePluginError =>
  new SourcePluginError({
    cause,
    message: `SQL source plugin ${operation} failed`,
  });

export const makeSqlSourceLookupMultipleRowsError = (
  identity: SourceIdentityInput,
  rowCount: number
): SourcePluginError =>
  new SourcePluginError({
    cause: {
      rowCount,
      sourceIdentity: identity,
    },
    message: "SQL source plugin readByIdentity returned multiple rows",
  });

export const makeSqlSourceLookupIdentityMismatchError = (
  requestedIdentity: SourceIdentityInput,
  returnedIdentity: SourceIdentityInput
): SourcePluginError =>
  new SourcePluginError({
    cause: {
      requestedSourceIdentity: requestedIdentity,
      returnedSourceIdentity: returnedIdentity,
    },
    message:
      "SQL source plugin readByIdentity returned a different Source Identity",
  });

export const makeSqlSourceMetadataError = (
  operation: SqlSourceOperation,
  rowIndex: number,
  message: string,
  cause?: unknown
): SourcePluginError =>
  new SourcePluginError({
    ...(cause === undefined ? {} : { cause }),
    message: `SQL source plugin ${operation} metadata failed for row ${rowIndex}: ${message}`,
  });
