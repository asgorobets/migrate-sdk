import type { ApiRoot } from "@commercetools/platform-sdk";
import { Context, Effect, Layer, Schema } from "effect";

export type CommercetoolsProject = ReturnType<ApiRoot["withProjectKey"]>;

export interface ExecutableCommercetoolsSdkRequest<A> {
  readonly execute: () => Promise<{ readonly body: A }>;
}

export type CommercetoolsSdkExecute = <A>(
  operation: string,
  request: ExecutableCommercetoolsSdkRequest<A>
) => Effect.Effect<A, CommercetoolsSdkError>;

export type CommercetoolsSdkRequest = <A>(
  operation: string,
  buildRequest: (
    project: CommercetoolsProject
  ) => ExecutableCommercetoolsSdkRequest<A>
) => Effect.Effect<A, CommercetoolsSdkError>;

export type CommercetoolsSdkLayer = Layer.Layer<CommercetoolsSdk>;

export interface CommercetoolsSdkLayerOptions {
  readonly apiRoot: ApiRoot;
  readonly projectKey: string;
}

export class CommercetoolsSdkError extends Schema.TaggedErrorClass<CommercetoolsSdkError>()(
  "CommercetoolsSdkError",
  {
    cause: Schema.Defect(),
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

const makeSdkRequest =
  (project: CommercetoolsProject): CommercetoolsSdkRequest =>
  (operation, buildRequest) =>
    executeSdkRequest(operation, buildRequest(project));

export class CommercetoolsSdk extends Context.Service<
  CommercetoolsSdk,
  {
    readonly execute: CommercetoolsSdkExecute;
    readonly project: CommercetoolsProject;
    readonly request: CommercetoolsSdkRequest;
  }
>()("@migrate-sdk/commercetools/CommercetoolsSdk") {
  static readonly layerFromApiRoot = (
    options: CommercetoolsSdkLayerOptions
  ): CommercetoolsSdkLayer =>
    Layer.sync(CommercetoolsSdk, () => {
      const project = options.apiRoot.withProjectKey({
        projectKey: options.projectKey,
      });

      return {
        execute: executeSdkRequest,
        project,
        request: makeSdkRequest(project),
      };
    });
}
