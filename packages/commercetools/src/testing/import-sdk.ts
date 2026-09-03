import type { ClientRequest } from "@commercetools/importapi-sdk";
import { ApiRoot as ImportApiRoot } from "@commercetools/importapi-sdk";
import { type Effect, Layer } from "effect";
import {
  type CommercetoolsImportProject,
  CommercetoolsImportSdk,
  type CommercetoolsImportSdkError,
  type CommercetoolsImportSdkLayer,
  type ExecutableCommercetoolsImportSdkRequest,
  makeCommercetoolsImportSdkError,
} from "../import-api/sdk.ts";
import {
  dispatchScriptedSdkRequest,
  isRecord,
  makeScriptedSdkRouteBuilder,
  type ScriptedSdkRequest,
  type ScriptedSdkRoute,
  type ScriptedSdkRouteBuilder,
} from "./internal/scripted-sdk.ts";

export interface ScriptedCommercetoolsImportSdkRequest
  extends ScriptedSdkRequest {
  readonly body?: unknown;
  readonly method: ClientRequest["method"];
  readonly operation: string;
  readonly pathVariables?: ClientRequest["pathVariables"];
  readonly queryParams?: ClientRequest["queryParams"];
  readonly uri?: string;
  readonly uriTemplate?: string;
}

export interface ScriptedCommercetoolsImportSdkRoute
  extends ScriptedSdkRoute<ScriptedCommercetoolsImportSdkRequest> {}

export interface ScriptedCommercetoolsImportSdkRouteBuilder
  extends ScriptedSdkRouteBuilder<ScriptedCommercetoolsImportSdkRequest> {}

export interface ScriptedCommercetoolsImportSdkOptions {
  readonly projectKey: string;
  readonly routes: readonly ScriptedCommercetoolsImportSdkRoute[];
}

export interface ScriptedCommercetoolsImportSdk {
  readonly layer: CommercetoolsImportSdkLayer;
  readonly requests: readonly ScriptedCommercetoolsImportSdkRequest[];
}

const isClientRequest = (value: unknown): value is ClientRequest =>
  isRecord(value) && typeof value.method === "string";

const requestFromExecutable = <A>(
  request: ExecutableCommercetoolsImportSdkRequest<A>
): ClientRequest => {
  if (
    isRecord(request) &&
    "clientRequest" in request &&
    typeof request.clientRequest === "function"
  ) {
    const clientRequest = request.clientRequest();

    if (isClientRequest(clientRequest)) {
      return clientRequest;
    }
  }

  throw new Error(
    "Scripted Commercetools Import SDK routes require generated SDK requests with request metadata."
  );
};

const scriptedRequest = (
  operation: string,
  request: ClientRequest
): ScriptedCommercetoolsImportSdkRequest => ({
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

export const scriptedCommercetoolsImportSdkRoute = (
  operation: string
): ScriptedCommercetoolsImportSdkRouteBuilder =>
  makeScriptedSdkRouteBuilder<ScriptedCommercetoolsImportSdkRequest>(operation);

export const makeScriptedCommercetoolsImportSdk = (
  options: ScriptedCommercetoolsImportSdkOptions
): ScriptedCommercetoolsImportSdk => {
  const requests: ScriptedCommercetoolsImportSdkRequest[] = [];
  const apiRoot = new ImportApiRoot({
    executeRequest: () => {
      throw new Error(
        "Scripted Commercetools Import SDK requests are dispatched before executeRequest."
      );
    },
  });
  const project = apiRoot.withProjectKeyValue({
    projectKey: options.projectKey,
  });

  const dispatch = <A>(
    operation: string,
    sdkRequest: ExecutableCommercetoolsImportSdkRequest<A>
  ): Effect.Effect<A, CommercetoolsImportSdkError> => {
    const request = scriptedRequest(
      operation,
      requestFromExecutable(sdkRequest)
    );
    return dispatchScriptedSdkRequest<
      A,
      ScriptedCommercetoolsImportSdkRequest,
      CommercetoolsImportSdkError
    >({
      makeError: makeCommercetoolsImportSdkError,
      request,
      requests,
      routes: options.routes,
      sdkName: "Commercetools Import SDK",
    });
  };

  const layer = Layer.sync(CommercetoolsImportSdk, () => ({
    execute: dispatch,
    project: project as CommercetoolsImportProject,
    request: (operation, buildRequest) =>
      dispatch(operation, buildRequest(project as CommercetoolsImportProject)),
  }));

  return {
    layer,
    requests,
  };
};

export const makeScriptedCommercetoolsImportSdkLayer = (
  options: ScriptedCommercetoolsImportSdkOptions
): CommercetoolsImportSdkLayer =>
  makeScriptedCommercetoolsImportSdk(options).layer;
