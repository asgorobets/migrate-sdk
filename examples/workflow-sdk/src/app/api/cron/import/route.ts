import { Effect } from "effect";
import { isAuthorizedCronRequest } from "@/server/auth";
import { migrateServerLayer } from "@/server/migrate-server";
import { startPeriodicCatalogImport } from "@/server/periodic-import";

export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = async (request: Request): Promise<Response> => {
  if (!isAuthorizedCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await Effect.runPromise(
      startPeriodicCatalogImport().pipe(Effect.provide(migrateServerLayer))
    );

    return Response.json(
      { ...result, target: "catalog" },
      { status: result.status === "started" ? 202 : 200 }
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return Response.json({ message, status: "error" }, { status: 500 });
  }
};
