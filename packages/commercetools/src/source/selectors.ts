import { Effect } from "effect";
import type {
  CommercetoolsEntitySourceBaseOptions,
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsPagedQueryResponse,
  CommercetoolsSourceCountQueryArgs,
  CommercetoolsSourceQueryArgs,
  CommercetoolsSourceWhereVariables,
} from "./domain.ts";
import { makeSourceError } from "./internal/source-errors.ts";
import type { CommercetoolsSourceCursor } from "./schemas.ts";

export const defaultSourceBatchSize = 100;
export const defaultSourceIdentity = "id" as const;

export const entitySourceBaseOptions = (
  options: CommercetoolsEntitySourceBaseOptions
): CommercetoolsEntitySourceBaseOptions => ({
  ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  ...(options.expand === undefined ? {} : { expand: options.expand }),
  ...(options.identity === undefined ? {} : { identity: options.identity }),
  ...(options.where === undefined ? {} : { where: options.where }),
  ...(options.whereVariables === undefined
    ? {}
    : { whereVariables: options.whereVariables }),
});

export const resolveBatchSize = (
  label: string,
  options: CommercetoolsEntitySourceBaseOptions
) => {
  const size = options.batchSize ?? defaultSourceBatchSize;

  return Number.isInteger(size) && size > 0
    ? Effect.succeed(size)
    : Effect.fail(
        makeSourceError(
          `${label} source batchSize must be a positive integer`,
          {
            batchSize: size,
          }
        )
      );
};

const asArray = (
  value: string | readonly string[] | undefined
): readonly string[] => {
  if (value === undefined) {
    return [];
  }

  return typeof value === "string" ? [value] : value;
};

const maybeStringArray = (
  value: readonly string[]
): string | string[] | undefined => {
  if (value.length === 0) {
    return undefined;
  }

  return value.length === 1 ? value[0] : [...value];
};

const queryVariableValue = (
  value: CommercetoolsSourceWhereVariables[string]
): boolean | boolean[] | number | number[] | string | string[] => {
  if (Array.isArray(value)) {
    return [...value] as boolean[] | number[] | string[];
  }

  return value as boolean | number | string;
};

const whereVariableQueryArgs = (
  variables: CommercetoolsSourceWhereVariables | undefined
): Record<
  string,
  boolean | boolean[] | number | number[] | string | string[]
> => {
  const queryArgs: Record<
    string,
    boolean | boolean[] | number | number[] | string | string[]
  > = {};

  for (const [name, value] of Object.entries(variables ?? {})) {
    queryArgs[`var.${name}`] = queryVariableValue(value);
  }

  return queryArgs;
};

export const makeReadQueryArgs = (
  options: CommercetoolsEntitySourceBaseOptions,
  cursor: CommercetoolsSourceCursor | null,
  limit: number
): CommercetoolsSourceQueryArgs => {
  const expand = maybeStringArray(asArray(options.expand));
  const where = maybeStringArray([
    ...asArray(options.where),
    ...(cursor === null ? [] : ["id > :lastId"]),
  ]);

  return {
    ...(expand === undefined ? {} : { expand }),
    limit,
    sort: "id asc",
    withTotal: false,
    ...(where === undefined ? {} : { where }),
    ...whereVariableQueryArgs(options.whereVariables),
    ...(cursor === null ? {} : { "var.lastId": cursor.lastId }),
  };
};

export const makeCountQueryArgs = (
  options: CommercetoolsEntitySourceBaseOptions
): CommercetoolsSourceCountQueryArgs => {
  const where = maybeStringArray(asArray(options.where));

  return {
    limit: 0,
    withTotal: true,
    ...(where === undefined ? {} : { where }),
    ...whereVariableQueryArgs(options.whereVariables),
  };
};

export const selectSourceIdentity = <
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsEntitySourceBaseOptions,
  resource: Resource
) => {
  if ((options.identity ?? defaultSourceIdentity) === "id") {
    return Effect.succeed(descriptor.getId(resource));
  }

  const key = descriptor.getKey(resource);

  return key === undefined || key.length === 0
    ? Effect.fail(
        makeSourceError(`${descriptor.label} source requires a resource key`, {
          resourceId: descriptor.getId(resource),
        })
      )
    : Effect.succeed(key);
};

export const nextCursorFromPage = <
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  page: Page
): CommercetoolsSourceCursor | undefined => {
  if (page.results.length === 0) {
    return undefined;
  }

  const lastResource = page.results.at(-1);

  return lastResource === undefined
    ? undefined
    : { lastId: descriptor.getId(lastResource) };
};
