import type {
  ApiRoot,
  ClientRequest,
  CustomObject,
  CustomObjectDraft,
  CustomObjectPagedQueryResponse,
} from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";
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

export interface ScriptedCustomObjectRoutes {
  readonly requests: readonly ScriptedCommercetoolsSdkRequest[];
  readonly routes: readonly ScriptedCommercetoolsSdkRoute[];
}

interface RecordedCustomObjectResponse {
  readonly body: CustomObject | CustomObjectPagedQueryResponse;
}

const recordedResponse = (
  body: CustomObject | CustomObjectPagedQueryResponse
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
    return undefined;
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

  return undefined;
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
  value: draft.value,
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

  return undefined;
};

const numberQueryParam = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
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
} | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const index =
    "index" in value && isRecord(value.index) && "definitionId" in value.index
      ? { definitionId: value.index.definitionId }
      : undefined;

  return {
    ...(index === undefined ? {} : { index }),
    namespace: "namespace" in value ? value.namespace : undefined,
    recordKind: "recordKind" in value ? value.recordKind : undefined,
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

  return (
    (!where.includes("value(namespace = :namespace)") ||
      value.namespace === namespace) &&
    (!where.includes("value(recordKind = :recordKind)") ||
      value.recordKind === recordKind) &&
    (!where.includes("value(index(definitionId = :definitionId))") ||
      value.index?.definitionId === definitionId) &&
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

const makeCustomObjectRecorderState = () => {
  const customObjects = new Map<string, CustomObject>();

  const executeCustomObjectRequest = (
    request: CustomObjectRecorderRequest
  ): Promise<RecordedCustomObjectResponse> => {
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
        .sort((left, right) => left.key.localeCompare(right.key))
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

export const makeRecordingCustomObjectApiRoot =
  (): RecordingCustomObjectApiRoot => {
    const requests: RecordedCustomObjectRequest[] = [];
    const state = makeCustomObjectRecorderState();

    return {
      apiRoot: new PlatformApiRoot({
        executeRequest: (request) => {
          const recordedRequest = recordRequest(request);
          requests.push(recordedRequest);

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
