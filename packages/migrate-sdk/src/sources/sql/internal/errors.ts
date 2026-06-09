import { SourcePluginError } from "../../../domain/errors.ts";

export type SqlSourceOperation = "read" | "readByIdentity";

export const makeSqlSourceNotImplementedError = (
  operation: SqlSourceOperation
): SourcePluginError =>
  new SourcePluginError({
    message: `SQL source plugin ${operation} is not implemented yet`,
  });
