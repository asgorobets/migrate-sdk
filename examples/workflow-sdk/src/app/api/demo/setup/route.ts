import { isAuthorizedMigrationRequest } from "@/server/auth";
import { setupDemoDatabase } from "@/server/demo-database";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = async (request: Request): Promise<Response> => {
  if (!isAuthorizedMigrationRequest(request)) {
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
