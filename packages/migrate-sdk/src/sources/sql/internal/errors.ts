import { SourcePluginError } from "../../../domain/errors.ts";

export type SqlSourceOperation = "read" | "readByIdentity";

export const makeSqlSourceExecutionError = (
  operation: SqlSourceOperation,
  cause: unknown
): SourcePluginError =>
  new SourcePluginError({
    cause,
    message: `SQL source plugin ${operation} failed`,
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
