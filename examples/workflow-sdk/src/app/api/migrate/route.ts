import { Layer } from "effect";
import { MigrateServerHttp } from "migrate-sdk/server/http";
import { migrateServerAuthorizationMiddleware } from "@/server/auth";
import { migrateServerHttpLayer } from "@/server/migrate-server";
import { MigrateServerAccess } from "@/server/migrate-server-access";

const migrateServerHttp = MigrateServerHttp.toWebHandler(
  Layer.merge(migrateServerHttpLayer, MigrateServerAccess.layer),
  migrateServerAuthorizationMiddleware
);

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = (request: Request) => migrateServerHttp.handler(request);
