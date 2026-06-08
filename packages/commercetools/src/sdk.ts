import type { ApiRoot } from "@commercetools/platform-sdk";
import { Context, Effect, Layer, Schema } from "effect";

export interface ExecutableCommercetoolsSdkRequest<A> {
  readonly execute: () => Promise<{ readonly body: A }>;
}

export type CommercetoolsSdkExecute = <A>(
  operation: string,
  request: ExecutableCommercetoolsSdkRequest<A>
) => Effect.Effect<A, CommercetoolsSdkError>;

export type CommercetoolsSdkLayer = Layer.Layer<CommercetoolsSdk>;

export class CommercetoolsSdkError extends Schema.TaggedErrorClass<CommercetoolsSdkError>()(
  "CommercetoolsSdkError",
  {
    cause: Schema.Defect,
    message: Schema.String,
    operation: Schema.String,
  }
) {}

const sdkError = (operation: string, cause: unknown): CommercetoolsSdkError =>
  new CommercetoolsSdkError({
    cause,
    message: `Commercetools SDK operation failed: ${operation}`,
    operation,
  });

const executeSdkRequest: CommercetoolsSdkExecute = (operation, request) =>
  Effect.tryPromise({
    try: () => request.execute(),
    catch: (cause) => sdkError(operation, cause),
  }).pipe(Effect.map((response) => response.body));

export class CommercetoolsSdk extends Context.Service<
  CommercetoolsSdk,
  {
    readonly apiRoot: ApiRoot;
    readonly execute: CommercetoolsSdkExecute;
  }
>()("@migrate-sdk/commercetools/CommercetoolsSdk") {
  static readonly layerFromApiRoot = (
    apiRoot: ApiRoot
  ): CommercetoolsSdkLayer =>
    Layer.succeed(CommercetoolsSdk, {
      apiRoot,
      execute: executeSdkRequest,
    });
}
