import { Effect } from "effect";
import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const isAuthorizedBearerHeader = (
  authorization: string | undefined,
  token: string | undefined
): boolean =>
  token !== undefined &&
  token.length > 0 &&
  authorization === `Bearer ${token}`;

export const isAuthorizedMigrationRequest = (request: Request): boolean =>
  isAuthorizedBearerHeader(
    request.headers.get("authorization") ?? undefined,
    process.env.MIGRATE_SERVER_TOKEN
  );

export const isAuthorizedCronRequest = (request: Request): boolean =>
  isAuthorizedBearerHeader(
    request.headers.get("authorization") ?? undefined,
    process.env.CRON_SECRET
  );

export const migrateServerAuthorizationMiddleware = HttpMiddleware.make(
  (httpApp) =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) =>
        isAuthorizedBearerHeader(
          request.headers.authorization,
          process.env.MIGRATE_SERVER_TOKEN
        )
          ? httpApp
          : Effect.succeed(
              HttpServerResponse.text("Unauthorized", { status: 401 })
            )
      )
    )
);
