import type { ApiRoot } from "@commercetools/platform-sdk";
import { Context, Layer, Schema } from "effect";
import {
  bindSdkRequest,
  type ExecutableSdkRequest,
  makeSdkExecute,
  type SdkExecute,
  type SdkRequest,
} from "./internal/sdk-binding.ts";

export type CommercetoolsProject = ReturnType<ApiRoot["withProjectKey"]>;

export interface ExecutableCommercetoolsSdkRequest<A>
  extends ExecutableSdkRequest<A> {}

export type CommercetoolsSdkExecute = SdkExecute<CommercetoolsSdkError>;

export type CommercetoolsSdkRequest = SdkRequest<
  CommercetoolsProject,
  CommercetoolsSdkError
>;

export type CommercetoolsSdkLayer = Layer.Layer<CommercetoolsSdk>;

export interface CommercetoolsSdkLayerOptions {
  readonly apiRoot: ApiRoot;
  readonly projectKey: string;
}

export class CommercetoolsSdkError extends Schema.TaggedError<CommercetoolsSdkError>()(
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

const executeSdkRequest: CommercetoolsSdkExecute = makeSdkExecute(sdkError);

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
        request: bindSdkRequest(project, executeSdkRequest),
      };
    });
}
