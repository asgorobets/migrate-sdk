import { Effect } from "effect";
import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { DemoSetupAccess } from "./demo-setup-access";
import { MigrateServerAccess } from "./migrate-server-access";

const isAuthorizedBearerHeader = (
  authorization: string | undefined,
  token: string | undefined
): boolean =>
  token !== undefined &&
  token.length > 0 &&
  authorization === `Bearer ${token}`;

export const isAuthorizedDemoSetupRequest = (
  request: Request
): Effect.Effect<boolean, never, DemoSetupAccess> =>
  DemoSetupAccess.pipe(
    Effect.map(({ token }) =>
      isAuthorizedBearerHeader(
        request.headers.get("authorization") ?? undefined,
        token
      )
    )
  );

export const isAuthorizedCronRequest = (request: Request): boolean =>
  isAuthorizedBearerHeader(
    request.headers.get("authorization") ?? undefined,
    process.env.CRON_SECRET
  );

export const migrateServerAuthorizationMiddleware = HttpMiddleware.make(
  (httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { token } = yield* MigrateServerAccess;
      if (!isAuthorizedBearerHeader(request.headers.authorization, token)) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      return yield* httpApp;
    })
);
