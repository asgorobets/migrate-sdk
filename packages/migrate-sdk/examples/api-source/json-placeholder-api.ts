import { Effect, flow, Layer, type Schema } from "effect";
import { Service } from "effect/Context";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { JsonPlaceholderPost, JsonPlaceholderPosts } from "./schemas.ts";

export type JsonPlaceholderApiError =
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export interface JsonPlaceholderApiState {
  readonly detailCalls: number[];
  listCalls: number;
}

export const makeJsonPlaceholderApiState = (): JsonPlaceholderApiState => ({
  detailCalls: [],
  listCalls: 0,
});

export class JsonPlaceholderApi extends Service<
  JsonPlaceholderApi,
  {
    readonly getPost: (
      id: number
    ) => Effect.Effect<unknown | null, JsonPlaceholderApiError>;
    readonly listPostIds: () => Effect.Effect<
      readonly number[],
      JsonPlaceholderApiError
    >;
  }
>()("@migrate-sdk/examples/JsonPlaceholderApi") {
  static readonly live = (options?: {
    readonly state?: JsonPlaceholderApiState;
  }): Layer.Layer<JsonPlaceholderApi> =>
    Layer.effect(JsonPlaceholderApi, makeLiveJsonPlaceholderApi(options)).pipe(
      Layer.provide(FetchHttpClient.layer)
    );
}

const makeLiveJsonPlaceholderApi = (options?: {
  readonly state?: JsonPlaceholderApiState;
}) =>
  Effect.gen(function* () {
    const state = options?.state;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl("https://jsonplaceholder.typicode.com"),
          HttpClientRequest.acceptJson
        )
      ),
      HttpClient.filterStatusOk
    );

    return JsonPlaceholderApi.of({
      getPost: Effect.fn("JsonPlaceholderApi.live.getPost")(function* (id) {
        const path = `/posts/${id}`;
        state?.detailCalls.push(id);

        return yield* client.get(path).pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(JsonPlaceholderPost)
          ),
          Effect.catchIf(
            (error) =>
              HttpClientError.isHttpClientError(error) &&
              error.reason._tag === "StatusCodeError" &&
              error.reason.response.status === 404,
            () => Effect.succeed(null)
          )
        );
      }),
      listPostIds: Effect.fn("JsonPlaceholderApi.live.listPostIds")(
        function* () {
          const path = "/posts";
          if (state !== undefined) {
            state.listCalls += 1;
          }

          const posts = yield* client
            .get(path)
            .pipe(
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(JsonPlaceholderPosts)
              )
            );

          return posts.map((post) => post.id);
        }
      ),
    });
  });
