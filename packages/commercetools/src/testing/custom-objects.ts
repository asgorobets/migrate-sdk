import type {
  ApiRoot,
  ClientRequest,
  CustomObject,
  CustomObjectDraft,
  CustomObjectPagedQueryResponse,
} from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";
import { Schema } from "effect";
import {
  type ScriptedCommercetoolsSdkRequest,
  type ScriptedCommercetoolsSdkRoute,
  scriptedCommercetoolsSdkRoute,
} from "./sdk.ts";

export interface RecordedCustomObjectRequest {
  readonly body?: ClientRequest["body"];
  readonly method: ClientRequest["method"];
  readonly pathVariables?: ClientRequest["pathVariables"];
  readonly queryParams?: ClientRequest["queryParams"];
  readonly uri?: string;
  readonly uriTemplate?: string;
}

export interface RecordingCustomObjectApiRoot {
  readonly apiRoot: ApiRoot;
  readonly requests: readonly RecordedCustomObjectRequest[];
}

export interface RecordingCustomObjectApiRootOptions {
  readonly beforeRequest?: (
    request: RecordedCustomObjectRequest
  ) => Promise<void> | void;
}

export interface ScriptedCustomObjectRoutes {
  readonly requests: readonly ScriptedCommercetoolsSdkRequest[];
  readonly routes: readonly ScriptedCommercetoolsSdkRoute[];
}

interface RecordedCustomObjectResponse {
  readonly body: unknown;
}

const recordedResponse = (
  body: unknown
): Promise<RecordedCustomObjectResponse> =>
  Promise.resolve({
    body,
  });

const isRecord = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const isCustomObjectDraft = (
  value: ClientRequest["body"]
): value is CustomObjectDraft =>
  isRecord(value) && "container" in value && "key" in value && "value" in value;

type CustomObjectRecorderRequest = RecordedCustomObjectRequest;
const afterKeyPattern = /key > ("(?:\\.|[^"\\])*")/u;

const isCustomObjectRequest = (request: CustomObjectRecorderRequest): boolean =>
  request.uriTemplate?.includes("custom-objects") === true;

const customObjectStorageKey = (container: string, key: string): string =>
  `${container}\u0000${key}`;

const customObjectContainer = (
  request: CustomObjectRecorderRequest
): string | undefined => {
  const container = request.pathVariables?.container;

  return typeof container === "string" ? container : undefined;
};

const customObjectPath = (
  request: CustomObjectRecorderRequest
): { readonly container: string; readonly key: string } | undefined => {
  const container = request.pathVariables?.container;
  const key = request.pathVariables?.key;

  if (typeof container !== "string" || typeof key !== "string") {
    return;
  }

  return { container, key };
};

const customObjectVersion = (
  request: CustomObjectRecorderRequest
): number | undefined => {
  const version = request.queryParams?.version;

  if (typeof version === "number") {
    return version;
  }

  if (typeof version === "string") {
    return Number.parseInt(version, 10);
  }

  return;
};

// Model the documented null omission recursively as a storage stress case.
// Array positions remain stable in this fake; the codec must preserve them.
const omitNullObjectFields = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(omitNullObjectFields);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== null)
        .map(([key, field]) => [key, omitNullObjectFields(field)])
    );
  }
  return value;
};

const recordedCustomObject = ({
  draft,
  id,
  version,
}: {
  readonly draft: CustomObjectDraft;
  readonly id: string;
  readonly version: number;
}): CustomObject => ({
  container: draft.container,
  createdAt: "2026-01-01T00:00:00.000Z",
  id,
  key: draft.key,
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  value: omitNullObjectFields(draft.value),
  version,
});

const recordedCustomObjectPage = ({
  limit,
  results,
}: {
  readonly limit: number;
  readonly results: readonly CustomObject[];
}): CustomObjectPagedQueryResponse => ({
  count: results.length,
  limit,
  offset: 0,
  results: [...results],
});

const stringQueryParam = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string")
      ? value.join(" and ")
      : undefined;
  }

  return;
};

const numberQueryParam = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return;
};

const queryVariable = (
  queryParams: RecordedCustomObjectRequest["queryParams"],
  name: string
): string | undefined => {
  const value = stringQueryParam(queryParams?.[`var.${name}`]);

  return value === "" ? undefined : value;
};

const valueRecord = (
  value: unknown
): {
  readonly index?: { readonly definitionId?: unknown };
  readonly namespace?: unknown;
  readonly recordKind?: unknown;
  readonly state?: { readonly lastSourceInventoryRunId?: unknown };
} | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const index =
    "index" in value && isRecord(value.index) && "definitionId" in value.index
      ? { definitionId: value.index.definitionId }
      : undefined;
  const state =
    "state" in value &&
    isRecord(value.state) &&
    "lastSourceInventoryRunId" in value.state
      ? { lastSourceInventoryRunId: value.state.lastSourceInventoryRunId }
      : undefined;

  return {
    ...(index === undefined ? {} : { index }),
    namespace: "namespace" in value ? value.namespace : undefined,
    recordKind: "recordKind" in value ? value.recordKind : undefined,
    ...(state === undefined ? {} : { state }),
  };
};

const customObjectMatchesWhere = (
  customObject: CustomObject,
  where: string | undefined,
  queryParams: RecordedCustomObjectRequest["queryParams"]
): boolean => {
  if (where === undefined) {
    return true;
  }

  const value = valueRecord(customObject.value);

  if (value === null) {
    return false;
  }

  const namespace = queryVariable(queryParams, "namespace");
  const recordKind = queryVariable(queryParams, "recordKind");
  const definitionId = queryVariable(queryParams, "definitionId");
  const lastKey = queryVariable(queryParams, "lastKey");
  const sourceInventoryRunId = queryVariable(
    queryParams,
    "sourceInventoryRunId"
  );

  return (
    (!where.includes("value(namespace = :namespace)") ||
      value.namespace === namespace) &&
    (!where.includes("value(recordKind = :recordKind)") ||
      value.recordKind === recordKind) &&
    (!where.includes("value(index(definitionId = :definitionId))") ||
      value.index?.definitionId === definitionId) &&
    (!where.includes(
      "value(state(lastSourceInventoryRunId is not defined or lastSourceInventoryRunId != :sourceInventoryRunId))"
    ) ||
      value.state?.lastSourceInventoryRunId !== sourceInventoryRunId) &&
    (!where.includes("key > :lastKey") ||
      (lastKey !== undefined && customObject.key > lastKey))
  );
};

const recordedError = <const StatusCode extends number>(
  message: string,
  statusCode: StatusCode
): Error & { readonly statusCode: StatusCode } =>
  Object.assign(new Error(message), {
    body: {
      message,
      statusCode,
    },
    code: statusCode,
    statusCode,
  } as const);

export const recordedNotFoundError = (
  message: string
): Error & { readonly statusCode: 404 } => recordedError(message, 404);

const recordedConflictError = (
  message: string
): Error & { readonly statusCode: 409 } => recordedError(message, 409);

const recordRequest = (
  request: CustomObjectRecorderRequest
): RecordedCustomObjectRequest => ({
  ...(request.body === undefined ? {} : { body: request.body }),
  method: request.method,
  ...(request.pathVariables === undefined
    ? {}
    : { pathVariables: request.pathVariables }),
  ...(request.queryParams === undefined
    ? {}
    : { queryParams: request.queryParams }),
  ...(request.uri === undefined ? {} : { uri: request.uri }),
  ...(request.uriTemplate === undefined
    ? {}
    : { uriTemplate: request.uriTemplate }),
});

const SummaryRequest = Schema.Struct({
  query: Schema.String,
  variables: Schema.StructWithRest(
    Schema.Struct({ container: Schema.String, limit: Schema.Int }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  ),
});
const SummaryStatus = Schema.Literals([
  "migrated",
  "skipped",
  "failed",
  "needs-update",
]);
const SummaryMetadata = Schema.Struct({
  formatVersion: Schema.Literal(1),
  index: Schema.Struct({ status: SummaryStatus }),
  state: Schema.Struct({ status: SummaryStatus }),
}).check(
  Schema.makeFilter(({ index, state }) => index.status === state.status)
);

const decodeSummaryRequest = Schema.decodeUnknownSync(SummaryRequest);
const decodePredicateString = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.String)
);
const decodeString = Schema.decodeUnknownSync(Schema.String);
const isValidSummaryMetadata = Schema.is(SummaryMetadata);

const quotedPredicateValue = (where: string, field: string): string => {
  const match = new RegExp(
    String.raw`${field} = ("(?:\\.|[^"\\])*")`,
    "u"
  ).exec(where);
  return decodePredicateString(match?.[1]);
};

const makeSummaryPredicate = (
  container: string,
  where: string
): ((object: CustomObject) => boolean) => {
  const invalidMetadata = where.includes("not (value(formatVersion");
  const matchesValue = Schema.is(
    Schema.Struct({
      namespace: Schema.Literal(quotedPredicateValue(where, "namespace")),
      recordKind: Schema.Literal(quotedPredicateValue(where, "recordKind")),
      index: Schema.Struct({
        definitionId: Schema.Literal(
          quotedPredicateValue(where, "definitionId")
        ),
        ...(invalidMetadata
          ? {}
          : { status: Schema.Literal(quotedPredicateValue(where, "status")) }),
      }),
    })
  );
  const encodedAfter = afterKeyPattern.exec(where)?.[1];
  const after =
    encodedAfter === undefined
      ? undefined
      : decodePredicateString(encodedAfter);

  return (object) =>
    object.container === container &&
    (after === undefined || object.key > after) &&
    matchesValue(object.value) &&
    !(invalidMetadata && isValidSummaryMetadata(object.value));
};

// Model the summary's GraphQL field selection without returning value. This
// recorder deliberately supports only this key-only Custom Object query.
const recordedSummaryResponse = (
  request: CustomObjectRecorderRequest,
  customObjects: ReadonlyMap<string, CustomObject>
): Promise<RecordedCustomObjectResponse> => {
  const { query, variables } = decodeSummaryRequest(request.body);
  const { container, limit } = variables;
  const data: Record<string, unknown> = {};
  for (const match of query.matchAll(/(\w+):\s*customObjects\(/gu)) {
    const alias = match[1];
    if (alias === undefined) {
      continue;
    }
    const where = decodeString(variables[`${alias}Where`]);
    const matches = [...customObjects.values()]
      .filter(makeSummaryPredicate(container, where))
      .sort((left, right) => (left.key < right.key ? -1 : 1));
    if (alias === "invalid") {
      data[alias] = { exists: matches.length > 0 };
    } else {
      const page = matches.slice(0, limit);
      data[alias] = {
        count: page.length,
        results: page.map(({ key }) => ({ key })),
      };
    }
  }
  return recordedResponse({ data });
};

const makeCustomObjectRecorderState = () => {
  const customObjects = new Map<string, CustomObject>();

  const executeCustomObjectRequest = (
    request: CustomObjectRecorderRequest
  ): Promise<RecordedCustomObjectResponse> => {
    if (
      request.method === "POST" &&
      request.uriTemplate?.endsWith("/graphql")
    ) {
      return recordedSummaryResponse(request, customObjects);
    }
    if (!isCustomObjectRequest(request)) {
      throw new Error(
        `Recording Custom Object API root only supports Custom Object requests: ${request.uriTemplate}`
      );
    }

    const body = request.body;

    if (request.method === "POST" && isCustomObjectDraft(body)) {
      const storageKey = customObjectStorageKey(body.container, body.key);
      const current = customObjects.get(storageKey);

      if (body.version === 0 && current !== undefined) {
        throw recordedConflictError(
          "Recorded Custom Object version does not match"
        );
      }

      if (
        body.version !== undefined &&
        body.version !== 0 &&
        current?.version !== body.version
      ) {
        throw recordedConflictError(
          "Recorded Custom Object version does not match"
        );
      }

      const next = recordedCustomObject({
        draft: body,
        id: current?.id ?? `recording-custom-object-${customObjects.size + 1}`,
        version: (current?.version ?? 0) + 1,
      });

      customObjects.set(storageKey, next);

      return recordedResponse(next);
    }

    const container = customObjectContainer(request);

    if (
      request.method === "GET" &&
      container !== undefined &&
      typeof request.pathVariables?.key !== "string"
    ) {
      const where = stringQueryParam(request.queryParams?.where);
      const limit = numberQueryParam(request.queryParams?.limit) ?? 20;
      const results = Array.from(customObjects.values())
        .filter(
          (customObject) =>
            customObject.container === container &&
            customObjectMatchesWhere(customObject, where, request.queryParams)
        )
        .sort((left, right) => {
          if (left.key === right.key) {
            return 0;
          }
          // Match the key comparison used by the keyset query predicate.
          return left.key < right.key ? -1 : 1;
        })
        .slice(0, limit);

      return recordedResponse(recordedCustomObjectPage({ limit, results }));
    }

    const path = customObjectPath(request);

    if (path === undefined) {
      throw new Error(
        `Recording Custom Object API root could not resolve request path: ${request.uriTemplate}`
      );
    }

    const storageKey = customObjectStorageKey(path.container, path.key);
    const current = customObjects.get(storageKey);

    if (current === undefined) {
      throw recordedNotFoundError("Recorded Custom Object was not found");
    }

    if (request.method === "GET") {
      return recordedResponse(current);
    }

    if (request.method === "DELETE") {
      const version = customObjectVersion(request);

      if (version !== current.version) {
        throw recordedConflictError(
          "Recorded Custom Object delete version does not match"
        );
      }

      customObjects.delete(storageKey);

      return recordedResponse(current);
    }

    throw new Error(
      `Recording Custom Object API root does not support ${request.method} ${request.uriTemplate}`
    );
  };

  return { executeCustomObjectRequest };
};

export const makeRecordingCustomObjectApiRoot = (
  options: RecordingCustomObjectApiRootOptions = {}
): RecordingCustomObjectApiRoot => {
  const requests: RecordedCustomObjectRequest[] = [];
  const state = makeCustomObjectRecorderState();

  return {
    apiRoot: new PlatformApiRoot({
      executeRequest: async (request) => {
        const recordedRequest = recordRequest(request);
        requests.push(recordedRequest);
        await options.beforeRequest?.(recordedRequest);

        return state.executeCustomObjectRequest(recordedRequest);
      },
    }),
    requests,
  };
};

const migrationStoreCustomObjectOperations = [
  "customObjects.deleteMigrationStoreRecord",
  "customObjects.getMigrationStoreRecord",
  "customObjects.queryMigrationStoreRecords",
  "customObjects.upsertMigrationStoreRecord",
  "graphql.summarizeMigrationItemStates",
] as const;

export const makeScriptedCustomObjectRoutes =
  (): ScriptedCustomObjectRoutes => {
    const requests: ScriptedCommercetoolsSdkRequest[] = [];
    const state = makeCustomObjectRecorderState();

    const respond = async (request: ScriptedCommercetoolsSdkRequest) => {
      requests.push(request);
      const response = await state.executeCustomObjectRequest(
        recordRequest(request)
      );

      return response.body;
    };

    return {
      requests,
      routes: migrationStoreCustomObjectOperations.map((operation) =>
        scriptedCommercetoolsSdkRoute(operation).replyWith(respond)
      ),
    };
  };
