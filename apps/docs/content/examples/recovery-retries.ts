import { Duration, Effect, Schedule } from "effect";
import { SourceError, type SourceRetryStrategy } from "migrate-sdk";
import { ApiRequestError, getAuthor } from "./recovery-api-errors";

const requestFailure = (error: unknown): ApiRequestError | undefined => {
  if (error instanceof ApiRequestError) {
    return error;
  }
  if (error instanceof SourceError && error.cause instanceof ApiRequestError) {
    return error.cause;
  }
  return;
};

const backoff = Schedule.exponential("250 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ input, duration }) => {
    const exponentialMs = Math.min(Duration.toMillis(duration), 4000);
    const retryAfterMs = requestFailure(input)?.retryAfterMs ?? 0;
    return Effect.succeed(Math.max(exponentialMs, retryAfterMs));
  })
);

export const retryTransient = <A, E, R>(request: Effect.Effect<A, E, R>) =>
  request.pipe(
    Effect.retry({
      schedule: backoff,
      times: 4,
      while: (error: E) => {
        const failure = requestFailure(error);
        return (
          failure?.transient === true && (failure.retryAfterMs ?? 0) <= 60_000
        );
      },
    })
  );

export const getAuthorWithRetry = (baseUrl: string, id: string) =>
  getAuthor(baseUrl, id).pipe(retryTransient);

// Optional wrappers for a source that preserves ApiRequestError in cause.
export const sourceRetry: SourceRetryStrategy = retryTransient;

export const sourceRetryOptions = {
  sourceCursorRetry: sourceRetry,
  sourceLookupRetry: sourceRetry,
};
