import type { ClientRequest } from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";
import { Effect, Layer } from "effect";
import {
  type CommercetoolsProject,
  CommercetoolsSdk,
  CommercetoolsSdkError,
  type CommercetoolsSdkLayer,
  type ExecutableCommercetoolsSdkRequest,
} from "../sdk.ts";

export interface ScriptedCommercetoolsSdkRequest {
  readonly body?: ClientRequest["body"];
  readonly method: ClientRequest["method"];
  readonly operation: string;
  readonly pathVariables?: ClientRequest["pathVariables"];
  readonly queryParams?: ClientRequest["queryParams"];
  readonly uri?: string;
  readonly uriTemplate?: string;
}

export interface ScriptedCommercetoolsSdkRoute {
  readonly description: string;
  readonly matches: (request: ScriptedCommercetoolsSdkRequest) => boolean;
  readonly respond: (
    request: ScriptedCommercetoolsSdkRequest
  ) => Promise<unknown> | unknown;
}

export interface ScriptedCommercetoolsSdkRouteBuilder {
  readonly fail: (cause: unknown) => ScriptedCommercetoolsSdkRoute;
  readonly match: (
    predicate: (request: ScriptedCommercetoolsSdkRequest) => boolean
  ) => ScriptedCommercetoolsSdkRouteBuilder;
  readonly matchBody: (
    predicate: (body: ClientRequest["body"] | undefined) => boolean
  ) => ScriptedCommercetoolsSdkRouteBuilder;
  readonly matchPath: (
    expected: Readonly<Record<string, unknown>>
  ) => ScriptedCommercetoolsSdkRouteBuilder;
  readonly matchQuery: (
    expected: Readonly<Record<string, unknown>>
  ) => ScriptedCommercetoolsSdkRouteBuilder;
  readonly reply: (body: unknown) => ScriptedCommercetoolsSdkRoute;
  readonly replyWith: (
    respond: (
      request: ScriptedCommercetoolsSdkRequest
    ) => Promise<unknown> | unknown
  ) => ScriptedCommercetoolsSdkRoute;
}

export interface ScriptedCommercetoolsSdkOptions {
  readonly projectKey: string;
  readonly routes: readonly ScriptedCommercetoolsSdkRoute[];
}

export interface ScriptedCommercetoolsSdk {
  readonly layer: CommercetoolsSdkLayer;
  readonly requests: readonly ScriptedCommercetoolsSdkRequest[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isClientRequest = (value: unknown): value is ClientRequest =>
  isRecord(value) &&
  typeof value.method === "string" &&
  typeof value.uriTemplate === "string";

const requestFromExecutable = <A>(
  request: ExecutableCommercetoolsSdkRequest<A>
): ClientRequest => {
  if (
    isRecord(request) &&
    "request" in request &&
    isClientRequest(request.request)
  ) {
    return request.request;
  }

  throw new Error(
    "Scripted Commercetools SDK routes require generated SDK requests with request metadata."
  );
};

const scriptedRequest = (
  operation: string,
  request: ClientRequest
): ScriptedCommercetoolsSdkRequest => ({
  ...(request.body === undefined ? {} : { body: request.body }),
  method: request.method,
  operation,
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

const recordMatches = (
  actual: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>>
): boolean =>
  Object.entries(expected).every(([key, value]) => actual?.[key] === value);

const requestSummary = (request: ScriptedCommercetoolsSdkRequest): string =>
  JSON.stringify(
    {
      body: request.body,
      method: request.method,
      operation: request.operation,
      pathVariables: request.pathVariables,
      queryParams: request.queryParams,
      uri: request.uri,
      uriTemplate: request.uriTemplate,
    },
    null,
    2
  );

const sdkError = (operation: string, cause: unknown): CommercetoolsSdkError =>
  new CommercetoolsSdkError({
    cause,
    message: `Commercetools SDK operation failed: ${operation}`,
    operation,
  });

const makeRouteBuilder = (
  operation: string,
  predicates: readonly ((
    request: ScriptedCommercetoolsSdkRequest
  ) => boolean)[] = []
): ScriptedCommercetoolsSdkRouteBuilder => {
  const matches = (request: ScriptedCommercetoolsSdkRequest): boolean =>
    request.operation === operation &&
    predicates.every((predicate) => predicate(request));

  const builder: ScriptedCommercetoolsSdkRouteBuilder = {
    fail: (cause) => ({
      description: operation,
      matches,
      respond: () => {
        throw cause;
      },
    }),
    match: (predicate) =>
      makeRouteBuilder(operation, [...predicates, predicate]),
    matchBody: (predicate) =>
      makeRouteBuilder(operation, [
        ...predicates,
        (request) => predicate(request.body),
      ]),
    matchPath: (expected) =>
      makeRouteBuilder(operation, [
        ...predicates,
        (request) => recordMatches(request.pathVariables, expected),
      ]),
    matchQuery: (expected) =>
      makeRouteBuilder(operation, [
        ...predicates,
        (request) => recordMatches(request.queryParams, expected),
      ]),
    reply: (body) => ({
      description: operation,
      matches,
      respond: () => body,
    }),
    replyWith: (respond) => ({
      description: operation,
      matches,
      respond,
    }),
  };

  return builder;
};

export const scriptedCommercetoolsSdkRoute = (
  operation: string
): ScriptedCommercetoolsSdkRouteBuilder => makeRouteBuilder(operation);

export const makeScriptedCommercetoolsSdk = (
  options: ScriptedCommercetoolsSdkOptions
): ScriptedCommercetoolsSdk => {
  const requests: ScriptedCommercetoolsSdkRequest[] = [];
  const apiRoot = new PlatformApiRoot({
    executeRequest: () => {
      throw new Error(
        "Scripted Commercetools SDK requests are dispatched before executeRequest."
      );
    },
  });
  const project = apiRoot.withProjectKey({
    projectKey: options.projectKey,
  });

  const dispatch = <A>(
    operation: string,
    sdkRequest: ExecutableCommercetoolsSdkRequest<A>
  ): Effect.Effect<A, CommercetoolsSdkError> => {
    const request = scriptedRequest(
      operation,
      requestFromExecutable(sdkRequest)
    );
    requests.push(request);

    const route = options.routes.find((candidate) =>
      candidate.matches(request)
    );

    if (route === undefined) {
      return Effect.fail(
        sdkError(
          operation,
          new Error(
            `No scripted Commercetools SDK route matched request:\n${requestSummary(request)}`
          )
        )
      );
    }

    return Effect.tryPromise({
      catch: (cause) => sdkError(operation, cause),
      try: async () => (await route.respond(request)) as A,
    });
  };

  const layer = Layer.sync(CommercetoolsSdk, () => ({
    execute: dispatch,
    project: project as CommercetoolsProject,
    request: (operation, buildRequest) =>
      dispatch(operation, buildRequest(project as CommercetoolsProject)),
  }));

  return {
    layer,
    requests,
  };
};

export const makeScriptedCommercetoolsSdkLayer = (
  options: ScriptedCommercetoolsSdkOptions
): CommercetoolsSdkLayer => makeScriptedCommercetoolsSdk(options).layer;
