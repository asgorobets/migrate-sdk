import type { ApiRoot } from "@commercetools/importapi-sdk";
import { Context, Layer, Schema } from "effect";
import {
  bindSdkRequest,
  type ExecutableSdkRequest,
  makeSdkExecute,
  type SdkExecute,
  type SdkRequest,
} from "../internal/sdk-binding.ts";

export type CommercetoolsImportProject = ReturnType<
  ApiRoot["withProjectKeyValue"]
>;

export interface ExecutableCommercetoolsImportSdkRequest<A>
  extends ExecutableSdkRequest<A> {}

export type CommercetoolsImportSdkExecute =
  SdkExecute<CommercetoolsImportSdkError>;

export type CommercetoolsImportSdkRequest = SdkRequest<
  CommercetoolsImportProject,
  CommercetoolsImportSdkError
>;

export type CommercetoolsImportSdkLayer = Layer.Layer<CommercetoolsImportSdk>;

export interface CommercetoolsImportSdkLayerOptions {
  readonly apiRoot: ApiRoot;
  readonly projectKey: string;
}

export interface CommercetoolsImportSdkService {
  readonly execute: CommercetoolsImportSdkExecute;
  readonly project: CommercetoolsImportProject;
  readonly request: CommercetoolsImportSdkRequest;
}

export class CommercetoolsImportSdkError extends Schema.TaggedError<CommercetoolsImportSdkError>()(
  "CommercetoolsImportSdkError",
  {
    acceptance: Schema.Literals(["not-accepted", "unknown"]),
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
    statusCode: Schema.optional(Schema.Int),
  }
) {}

const statusCodeFromCause = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null) {
    return;
  }

  const candidate = cause as {
    readonly response?: {
      readonly status?: unknown;
      readonly statusCode?: unknown;
    };
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const statusCode =
    candidate.statusCode ??
    candidate.status ??
    candidate.response?.statusCode ??
    candidate.response?.status;

  return typeof statusCode === "number" && Number.isInteger(statusCode)
    ? statusCode
    : undefined;
};

export const makeCommercetoolsImportSdkError = (
  operation: string,
  cause: unknown
): CommercetoolsImportSdkError => {
  const statusCode = statusCodeFromCause(cause);
  const definitelyRejected =
    statusCode !== undefined && statusCode >= 400 && statusCode < 500;

  return new CommercetoolsImportSdkError({
    acceptance: definitelyRejected ? "not-accepted" : "unknown",
    cause,
    message: `Commercetools Import SDK operation failed: ${operation}`,
    operation,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
};

const executeSdkRequest: CommercetoolsImportSdkExecute = makeSdkExecute(
  makeCommercetoolsImportSdkError
);

export class CommercetoolsImportSdk extends Context.Service<
  CommercetoolsImportSdk,
  CommercetoolsImportSdkService
>()("@migrate-sdk/commercetools/CommercetoolsImportSdk") {
  static readonly layerFromApiRoot = (
    options: CommercetoolsImportSdkLayerOptions
  ): CommercetoolsImportSdkLayer =>
    Layer.sync(CommercetoolsImportSdk, () => {
      const project = options.apiRoot.withProjectKeyValue({
        projectKey: options.projectKey,
      });

      return {
        execute: executeSdkRequest,
        project,
        request: bindSdkRequest(project, executeSdkRequest),
      };
    });
}
