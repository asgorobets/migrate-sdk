import { Effect } from "effect";

export interface ExecutableSdkRequest<A> {
  readonly execute: () => Promise<{ readonly body: A }>;
}

export type SdkExecute<Error> = <A>(
  operation: string,
  request: ExecutableSdkRequest<A>
) => Effect.Effect<A, Error>;

export type SdkRequest<Project, Error> = <A>(
  operation: string,
  buildRequest: (project: Project) => ExecutableSdkRequest<A>
) => Effect.Effect<A, Error>;

export const makeSdkExecute =
  <Error>(
    makeError: (operation: string, cause: unknown) => Error
  ): SdkExecute<Error> =>
  (operation, request) =>
    Effect.tryPromise({
      try: () => request.execute(),
      catch: (cause) => makeError(operation, cause),
    }).pipe(Effect.map((response) => response.body));

export const bindSdkRequest =
  <Project, Error>(
    project: Project,
    execute: SdkExecute<Error>
  ): SdkRequest<Project, Error> =>
  (operation, buildRequest) =>
    execute(operation, buildRequest(project));
