import { Cause, Effect, type Layer, Schedule, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { defineSourcePlugin, type SourcePluginError } from "migrate-sdk";
import { jsonPlaceholderError } from "./errors.ts";
import {
  JsonPlaceholderApi,
  type JsonPlaceholderApiError,
} from "./json-placeholder-api.ts";
import { JsonPlaceholderPost, JsonPlaceholderPostCursor } from "./schemas.ts";

export interface JsonPlaceholderPostSourceOptions {
  readonly apiLayer?: Layer.Layer<JsonPlaceholderApi>;
}

const defaultDetailConcurrency = 2;
const defaultMaxPosts = 5;
const defaultPageSize = 2;
const defaultRequestTimeout = "2 seconds";
const defaultRetrySchedule = Schedule.exponential("50 millis").pipe(
  Schedule.both(Schedule.recurs(2))
);
const transientHttpStatuses = [408, 429, 500, 502, 503, 504];

const identityToPostId = (identity: string): number | null => {
  const postId = Number(identity);

  return Number.isInteger(postId) && postId > 0 ? postId : null;
};

const requirePostDetails = (post: unknown | null, id: number) =>
  post === null
    ? Effect.fail(
        jsonPlaceholderError("JSONPlaceholder post detail was not found", {
          id,
        })
      )
    : Effect.succeed(post);

const decodePost = (post: unknown) =>
  Schema.decodeUnknownEffect(JsonPlaceholderPost)(post).pipe(
    Effect.mapError((cause) =>
      jsonPlaceholderError(
        "JSONPlaceholder post did not match Source Payload Schema",
        cause
      )
    )
  );

const makePostSourceItem = (post: unknown) =>
  decodePost(post).pipe(
    Effect.map((decodedPost) => ({
      identity: String(decodedPost.id),
      item: decodedPost,
      version: `jsonplaceholder-post:${decodedPost.id}:${decodedPost.title.length}:${decodedPost.body.length}`,
    }))
  );

export const JsonPlaceholderPostSourcePlugin = {
  make: (options?: JsonPlaceholderPostSourceOptions) => {
    const apiLayer = options?.apiLayer ?? JsonPlaceholderApi.live();

    type ResilientApiError = JsonPlaceholderApiError | Cause.TimeoutError;

    const isTransientHttpClientError = (
      error: unknown
    ): error is HttpClientError.HttpClientError =>
      HttpClientError.isHttpClientError(error) &&
      (error.reason._tag === "TransportError" ||
        (error.reason._tag === "StatusCodeError" &&
          transientHttpStatuses.includes(error.reason.response.status)));

    const isRetryableApiError = (error: ResilientApiError): boolean =>
      Cause.isTimeoutError(error) || isTransientHttpClientError(error);

    const toSourcePluginError = (cause: ResilientApiError) =>
      jsonPlaceholderError(
        Cause.isTimeoutError(cause)
          ? "JSONPlaceholder request timed out"
          : "JSONPlaceholder API request failed",
        cause
      );

    const resilient = <A, Requirements>(
      effect: Effect.Effect<A, JsonPlaceholderApiError, Requirements>
    ): Effect.Effect<A, SourcePluginError, Requirements> =>
      effect.pipe(
        Effect.timeout(defaultRequestTimeout),
        Effect.retry({
          schedule: defaultRetrySchedule,
          while: isRetryableApiError,
        }),
        Effect.mapError(toSourcePluginError)
      );

    const withApi = <A>(
      effect: Effect.Effect<A, SourcePluginError, JsonPlaceholderApi>
    ): Effect.Effect<A, SourcePluginError> =>
      effect.pipe(Effect.provide(apiLayer));

    return defineSourcePlugin({
      cursorSchema: JsonPlaceholderPostCursor,
      sourceSchema: JsonPlaceholderPost,
      lookupStrategy: "direct",
      read: Effect.fn("JsonPlaceholderPostSource.read")((cursor) =>
        withApi(
          Effect.gen(function* () {
            const api = yield* JsonPlaceholderApi;
            const offset = cursor?.offset ?? 0;
            const postIds = (yield* resilient(api.listPostIds())).slice(
              0,
              defaultMaxPosts
            );
            const window = postIds.slice(offset, offset + defaultPageSize);
            const items = yield* Effect.forEach(
              window,
              (id) =>
                resilient(api.getPost(id)).pipe(
                  Effect.flatMap((post) => requirePostDetails(post, id)),
                  Effect.flatMap(makePostSourceItem)
                ),
              { concurrency: defaultDetailConcurrency }
            );
            const nextOffset = offset + defaultPageSize;

            return {
              items,
              nextCursor:
                nextOffset < postIds.length
                  ? { offset: nextOffset }
                  : undefined,
            };
          })
        )
      ),
      readByIdentity: Effect.fn("JsonPlaceholderPostSource.readByIdentity")(
        (identity) =>
          withApi(
            Effect.gen(function* () {
              const api = yield* JsonPlaceholderApi;
              const postId = identityToPostId(identity);

              if (postId === null) {
                return null;
              }

              const post = yield* resilient(api.getPost(postId));
              return post === null ? null : yield* makePostSourceItem(post);
            })
          )
      ),
    });
  },
} as const;
