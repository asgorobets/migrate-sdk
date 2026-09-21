import { Data, Effect, Schema } from "effect";

export class ApiRequestError extends Data.TaggedError("ApiRequestError")<{
  readonly message: string;
  readonly transient: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
}> {}

export class InvalidApiResponse extends Data.TaggedError("InvalidApiResponse")<{
  readonly message: string;
}> {}

const retryAfterMilliseconds = (value: string | null): number | undefined => {
  if (value === null) {
    return;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const transientTransportFailure = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) {
    return false;
  }
  if (cause.name === "TimeoutError") {
    return true;
  }
  const detail = cause.cause;
  return (
    typeof detail === "object" &&
    detail !== null &&
    "code" in detail &&
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(String(detail.code))
  );
};

// Contract: GET {baseUrl}/authors/{id} returns { id: string, name: string }.
// Supply your own API URL. This module makes no requests when imported.
const requestAuthor = (baseUrl: string, id: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${baseUrl}/authors/${encodeURIComponent(id)}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }),
      catch: (cause) =>
        new ApiRequestError({
          message: "Author request did not complete",
          transient: transientTransportFailure(cause),
        }),
    });

    if (!response.ok) {
      const retryAfterMs = retryAfterMilliseconds(
        response.headers.get("retry-after")
      );
      yield* Effect.tryPromise(
        () => response.body?.cancel() ?? Promise.resolve()
      ).pipe(Effect.ignore);
      return yield* Effect.fail(
        new ApiRequestError({
          message: `Author request returned HTTP ${response.status}`,
          status: response.status,
          transient: [408, 429, 502, 503, 504].includes(response.status),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        })
      );
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new ApiRequestError({
          message: "Author response body did not complete",
          transient: transientTransportFailure(cause),
        }),
    });

    return yield* Effect.try({
      try: (): unknown => JSON.parse(body),
      catch: () =>
        new InvalidApiResponse({
          message: "Author response was not valid JSON",
        }),
    });
  });

export const ApiAuthor = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});

export const getAuthor = (baseUrl: string, id: string) =>
  requestAuthor(baseUrl, id).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ApiAuthor))
  );
