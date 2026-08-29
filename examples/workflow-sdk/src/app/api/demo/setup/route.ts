import { Effect } from "effect";
import { isAuthorizedMigrationRequest } from "@/server/auth";
import { setupDemoDatabase } from "@/server/demo-database";
import { MigrateServerAccess } from "@/server/migrate-server-access";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = async (request: Request): Promise<Response> => {
  const authorized = await Effect.runPromise(
    isAuthorizedMigrationRequest(request).pipe(
      Effect.provide(MigrateServerAccess.layer)
    )
  );
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const counts = await setupDemoDatabase({
      reset: new URL(request.url).searchParams.get("reset") === "true",
    });

    return Response.json({ counts, status: "ready" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return Response.json({ message, status: "error" }, { status: 500 });
  }
};
