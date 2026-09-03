import { Effect } from "effect";

export interface ScriptedSdkRequest {
  readonly body?: unknown | undefined;
  readonly method: string;
  readonly operation: string;
  readonly pathVariables?: Readonly<Record<string, unknown>> | undefined;
  readonly queryParams?: Readonly<Record<string, unknown>> | undefined;
  readonly uri?: string | undefined;
  readonly uriTemplate?: string | undefined;
}

export interface ScriptedSdkRoute<Request extends ScriptedSdkRequest> {
  readonly description: string;
  readonly matches: (request: Request) => boolean;
  readonly respond: (request: Request) => Promise<unknown> | unknown;
}

export interface ScriptedSdkRouteBuilder<
  Request extends ScriptedSdkRequest,
  Body = unknown,
> {
  readonly fail: (cause: unknown) => ScriptedSdkRoute<Request>;
  readonly match: (
    predicate: (request: Request) => boolean
  ) => ScriptedSdkRouteBuilder<Request, Body>;
  readonly matchBody: (
    predicate: (body: Body | undefined) => boolean
  ) => ScriptedSdkRouteBuilder<Request, Body>;
  readonly matchPath: (
    expected: Readonly<Record<string, unknown>>
  ) => ScriptedSdkRouteBuilder<Request, Body>;
  readonly matchQuery: (
    expected: Readonly<Record<string, unknown>>
  ) => ScriptedSdkRouteBuilder<Request, Body>;
  readonly reply: (body: unknown) => ScriptedSdkRoute<Request>;
  readonly replyWith: (
    respond: (request: Request) => Promise<unknown> | unknown
  ) => ScriptedSdkRoute<Request>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordMatches = (
  actual: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>>
): boolean =>
  Object.entries(expected).every(([key, value]) => actual?.[key] === value);

export const makeScriptedSdkRouteBuilder = <
  Request extends ScriptedSdkRequest,
  Body = unknown,
>(
  operation: string,
  predicates: readonly ((request: Request) => boolean)[] = []
): ScriptedSdkRouteBuilder<Request, Body> => {
  const next = (predicate: (request: Request) => boolean) =>
    makeScriptedSdkRouteBuilder<Request, Body>(operation, [
      ...predicates,
      predicate,
    ]);
  const matches = (request: Request): boolean =>
    request.operation === operation &&
    predicates.every((predicate) => predicate(request));

  return {
    fail: (cause) => ({
      description: operation,
      matches,
      respond: () => {
        throw cause;
      },
    }),
    match: next,
    matchBody: (predicate) =>
      next((request) => predicate(request.body as Body)),
    matchPath: (expected) =>
      next((request) => recordMatches(request.pathVariables, expected)),
    matchQuery: (expected) =>
      next((request) => recordMatches(request.queryParams, expected)),
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
};

export const dispatchScriptedSdkRequest = <
  A,
  Request extends ScriptedSdkRequest,
  Error,
>(options: {
  readonly makeError: (operation: string, cause: unknown) => Error;
  readonly request: Request;
  readonly requests: Request[];
  readonly routes: readonly ScriptedSdkRoute<Request>[];
  readonly sdkName: string;
}): Effect.Effect<A, Error> => {
  options.requests.push(options.request);
  const route = options.routes.find((candidate) =>
    candidate.matches(options.request)
  );

  if (route === undefined) {
    return Effect.fail(
      options.makeError(
        options.request.operation,
        new Error(
          `No scripted ${options.sdkName} route matched request:\n${JSON.stringify(options.request, null, 2)}`
        )
      )
    );
  }

  return Effect.tryPromise({
    catch: (cause) => options.makeError(options.request.operation, cause),
    try: async () => (await route.respond(options.request)) as A,
  });
};
