import { type Duration, Effect, Layer, Schema } from "effect";
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  JsonPlaceholderApi,
  type JsonPlaceholderApiState,
} from "./json-placeholder-api.ts";
import { JsonPlaceholderPost } from "./schemas.ts";

export interface ScriptedJsonPlaceholderApiState
  extends JsonPlaceholderApiState {
  activeDetailCalls: number;
  readonly detailAttemptsById: Record<number, number>;
  maxActiveDetailCalls: number;
}

type ScriptedDetailAction = "rate-limit" | "success" | "timeout";

export interface ScriptedJsonPlaceholderApiLayerOptions {
  readonly detailDelay?: Duration.Input;
  readonly detailScripts?: Readonly<
    Record<number, readonly ScriptedDetailAction[]>
  >;
}

export const makeScriptedJsonPlaceholderApiState =
  (): ScriptedJsonPlaceholderApiState => ({
    activeDetailCalls: 0,
    detailAttemptsById: {},
    detailCalls: [],
    listCalls: 0,
    maxActiveDetailCalls: 0,
  });

const defaultPosts = Schema.decodeUnknownSync(
  Schema.Array(JsonPlaceholderPost)
)([
  {
    body: "Effect gives source authors a practical way to compose HTTP calls.",
    id: 1,
    title: "Composable sources",
    userId: 1,
  },
  {
    body: "The list endpoint discovers ids, while detail endpoints build items.",
    id: 2,
    title: "List plus detail API stitching",
    userId: 1,
  },
  {
    body: "Bounded concurrency keeps detail lookups from overwhelming the API.",
    id: 3,
    title: "Bounded detail fetches",
    userId: 2,
  },
]);

const simulatedTimeoutDelay = "10 seconds";

const simulatedRateLimitError = (id: number) => {
  const request = HttpClientRequest.get(
    `https://jsonplaceholder.typicode.com/posts/${id}`
  );
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(null, { status: 429 })
  );

  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response,
    }),
  });
};

export const scriptedJsonPlaceholderApiLayer = (
  state: ScriptedJsonPlaceholderApiState,
  options?: ScriptedJsonPlaceholderApiLayerOptions
): Layer.Layer<JsonPlaceholderApi> =>
  Layer.sync(JsonPlaceholderApi, () => {
    const postsById = new Map(defaultPosts.map((post) => [post.id, post]));
    const scripts = new Map(
      Object.entries(options?.detailScripts ?? {}).map(([id, actions]) => [
        Number(id),
        [...actions],
      ])
    );
    const detailDelay = options?.detailDelay ?? 0;

    const runWithActiveDetailSlot = <A, E>(
      effect: Effect.Effect<A, E>
    ): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          state.activeDetailCalls += 1;
          state.maxActiveDetailCalls = Math.max(
            state.maxActiveDetailCalls,
            state.activeDetailCalls
          );
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            state.activeDetailCalls -= 1;
          })
      );

    return {
      getPost: Effect.fn("JsonPlaceholderApi.scripted.getPost")(function* (id) {
        state.detailCalls.push(id);
        state.detailAttemptsById[id] = (state.detailAttemptsById[id] ?? 0) + 1;

        const post = postsById.get(id) ?? null;

        if (post === null) {
          return null;
        }

        const actions = scripts.get(id);
        const action = actions?.shift() ?? "success";

        if (action === "rate-limit") {
          return yield* simulatedRateLimitError(id);
        }

        const delay =
          action === "timeout" ? simulatedTimeoutDelay : detailDelay;

        return yield* runWithActiveDetailSlot(
          Effect.sleep(delay).pipe(Effect.as(post))
        );
      }),
      listPostIds: Effect.gen(function* () {
        state.listCalls += 1;

        return defaultPosts.map((post) => post.id);
      }).pipe(Effect.withSpan("JsonPlaceholderApi.scripted.listPostIds")),
    };
  });
