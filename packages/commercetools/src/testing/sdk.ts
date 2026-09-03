import type { ClientRequest } from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";
import { type Effect, Layer } from "effect";
import {
  type CommercetoolsProject,
  CommercetoolsSdk,
  CommercetoolsSdkError,
  type CommercetoolsSdkLayer,
  type ExecutableCommercetoolsSdkRequest,
} from "../sdk.ts";
import {
  dispatchScriptedSdkRequest,
  isRecord,
  makeScriptedSdkRouteBuilder,
  type ScriptedSdkRequest,
  type ScriptedSdkRoute,
  type ScriptedSdkRouteBuilder,
} from "./internal/scripted-sdk.ts";

export interface ScriptedCommercetoolsSdkRequest extends ScriptedSdkRequest {
  readonly body?: ClientRequest["body"];
  readonly method: ClientRequest["method"];
  readonly operation: string;
  readonly pathVariables?: ClientRequest["pathVariables"];
  readonly queryParams?: ClientRequest["queryParams"];
  readonly uri?: string;
  readonly uriTemplate?: string;
}

export interface ScriptedCommercetoolsSdkRoute
  extends ScriptedSdkRoute<ScriptedCommercetoolsSdkRequest> {}

export interface ScriptedCommercetoolsSdkRouteBuilder
  extends ScriptedSdkRouteBuilder<
    ScriptedCommercetoolsSdkRequest,
    ClientRequest["body"]
  > {}

export interface ScriptedCommercetoolsSdkOptions {
  readonly projectKey: string;
  readonly routes: readonly ScriptedCommercetoolsSdkRoute[];
}

export interface ScriptedCommercetoolsSdk {
  readonly layer: CommercetoolsSdkLayer;
  readonly requests: readonly ScriptedCommercetoolsSdkRequest[];
}

const isClientRequest = (value: unknown): value is ClientRequest =>
  isRecord(value) &&
  typeof value.method === "string" &&
  typeof value.uriTemplate === "string";

const requestFromExecutable = <A>(
  request: ExecutableCommercetoolsSdkRequest<A>
): ClientRequest => {
  if (
    isRecord(request) &&
    "request" in request &&
    isClientRequest(request.request)
  ) {
    return request.request;
  }

  throw new Error(
    "Scripted Commercetools SDK routes require generated SDK requests with request metadata."
  );
};

const scriptedRequest = (
  operation: string,
  request: ClientRequest
): ScriptedCommercetoolsSdkRequest => ({
  ...(request.body === undefined ? {} : { body: request.body }),
  method: request.method,
  operation,
  ...(request.pathVariables === undefined
    ? {}
    : { pathVariables: request.pathVariables }),
  ...(request.queryParams === undefined
    ? {}
    : { queryParams: request.queryParams }),
  ...(request.uri === undefined ? {} : { uri: request.uri }),
  ...(request.uriTemplate === undefined
    ? {}
    : { uriTemplate: request.uriTemplate }),
});

const sdkError = (operation: string, cause: unknown): CommercetoolsSdkError =>
  new CommercetoolsSdkError({
    cause,
    message: `Commercetools SDK operation failed: ${operation}`,
    operation,
  });

export const scriptedCommercetoolsSdkRoute = (
  operation: string
): ScriptedCommercetoolsSdkRouteBuilder =>
  makeScriptedSdkRouteBuilder<
    ScriptedCommercetoolsSdkRequest,
    ClientRequest["body"]
  >(operation);

export const makeScriptedCommercetoolsSdk = (
  options: ScriptedCommercetoolsSdkOptions
): ScriptedCommercetoolsSdk => {
  const requests: ScriptedCommercetoolsSdkRequest[] = [];
  const apiRoot = new PlatformApiRoot({
    executeRequest: () => {
      throw new Error(
        "Scripted Commercetools SDK requests are dispatched before executeRequest."
      );
    },
  });
  const project = apiRoot.withProjectKey({
    projectKey: options.projectKey,
  });

  const dispatch = <A>(
    operation: string,
    sdkRequest: ExecutableCommercetoolsSdkRequest<A>
  ): Effect.Effect<A, CommercetoolsSdkError> => {
    const request = scriptedRequest(
      operation,
      requestFromExecutable(sdkRequest)
    );
    return dispatchScriptedSdkRequest<
      A,
      ScriptedCommercetoolsSdkRequest,
      CommercetoolsSdkError
    >({
      makeError: sdkError,
      request,
      requests,
      routes: options.routes,
      sdkName: "Commercetools SDK",
    });
  };

  const layer = Layer.sync(CommercetoolsSdk, () => ({
    execute: dispatch,
    project: project as CommercetoolsProject,
    request: (operation, buildRequest) =>
      dispatch(operation, buildRequest(project as CommercetoolsProject)),
  }));

  return {
    layer,
    requests,
  };
};

export const makeScriptedCommercetoolsSdkLayer = (
  options: ScriptedCommercetoolsSdkOptions
): CommercetoolsSdkLayer => makeScriptedCommercetoolsSdk(options).layer;
