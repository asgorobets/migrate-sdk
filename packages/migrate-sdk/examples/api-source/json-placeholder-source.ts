import { Cause, Effect, type Layer, Schedule, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { SourceIdentity, type SourcePluginError } from "migrate-sdk";
import {
  DocumentFetchers,
  DocumentParsers,
  DocumentSourcePlugin,
} from "migrate-sdk/sources/document";
import { jsonPlaceholderError } from "./errors.ts";
import {
  JsonPlaceholderApi,
  type JsonPlaceholderApiError,
} from "./json-placeholder-api.ts";
import {
  JsonPlaceholderPostCursor,
  JsonPlaceholderPostsDocument,
} from "./schemas.ts";

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

const requirePostDetails = (post: unknown | null, id: number) =>
  post === null
    ? Effect.fail(
        jsonPlaceholderError("JSONPlaceholder post detail was not found", {
          id,
        })
      )
    : Effect.succeed(post);

const makePostDocumentResource = (posts: readonly unknown[]) => ({
  posts,
});

const makePostPageFetcher = (apiLayer: Layer.Layer<JsonPlaceholderApi>) =>
  DocumentFetchers.effect({
    cursorSchema: JsonPlaceholderPostCursor,
    read: (cursor) =>
      Effect.gen(function* () {
        const api = yield* JsonPlaceholderApi;
        const offset = cursor?.offset ?? 0;
        const postIds = (yield* resilient(api.listPostIds())).slice(
          0,
          defaultMaxPosts
        );
        const window = postIds.slice(offset, offset + defaultPageSize);
        const posts = yield* Effect.forEach(
          window,
          (id) =>
            resilient(api.getPost(id)).pipe(
              Effect.flatMap((post) => requirePostDetails(post, id))
            ),
          { concurrency: defaultDetailConcurrency }
        );
        const nextOffset = offset + defaultPageSize;

        return {
          fingerprint: `jsonplaceholder-posts:${window.join(",")}`,
          nextCursor:
            nextOffset < postIds.length ? { offset: nextOffset } : undefined,
          resource: makePostDocumentResource(posts),
        };
      }),
    layer: apiLayer,
  });

const makePostDirectLookup = (apiLayer: Layer.Layer<JsonPlaceholderApi>) => ({
  kind: "direct" as const,
  read: (identity: { readonly key: number }) =>
    Effect.gen(function* () {
      const api = yield* JsonPlaceholderApi;
      const postId = identity.key;

      if (!Number.isInteger(postId) || postId <= 0) {
        return null;
      }

      const post = yield* resilient(api.getPost(postId));

      return post === null
        ? null
        : {
            fingerprint: `jsonplaceholder-post:${postId}`,
            resource: makePostDocumentResource([post]),
          };
    }).pipe(Effect.provide(apiLayer)),
});

export const JsonPlaceholderPostSourcePlugin = {
  make: (options?: JsonPlaceholderPostSourceOptions) => {
    const apiLayer = options?.apiLayer ?? JsonPlaceholderApi.live();

    return DocumentSourcePlugin.make({
      fetcher: makePostPageFetcher(apiLayer),
      parser: DocumentParsers.schema(
        "jsonplaceholder-posts",
        JsonPlaceholderPostsDocument
      ),
      selector: {
        item: (document) => document.posts,
      },
      identity: {
        id: "jsonplaceholder-post@v1",
        schema: SourceIdentity.key("postId", Schema.Number),
        key: ({ item }) => item.id,
      },
      lookup: makePostDirectLookup(apiLayer),
      version: {
        kind: "value",
        value: ({ item }) =>
          `jsonplaceholder-post:${item.id}:${item.title.length}:${item.body.length}`,
      },
    });
  },
} as const;
