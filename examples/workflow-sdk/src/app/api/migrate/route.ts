import { MigrateServerHttp } from "migrate-sdk/server/http";
import { migrateServerAuthorizationMiddleware } from "@/server/auth";
import { migrateServerHttpLayer } from "@/server/migrate-server";

const migrateServerHttp = MigrateServerHttp.toWebHandler(
  migrateServerHttpLayer,
  migrateServerAuthorizationMiddleware
);

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = (request: Request) => migrateServerHttp.handler(request);
