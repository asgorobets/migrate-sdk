import { Effect } from "effect";
import { isAuthorizedDemoSetupRequest } from "@/server/auth";
import { setupDemoDatabase } from "@/server/demo-database";
import { DemoSetupAccess } from "@/server/demo-setup-access";
import catalogFixtureSnapshot from "../../../../../../../fixtures/catalog/books.csv?raw";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = async (request: Request): Promise<Response> => {
  const authorized = await Effect.runPromise(
    isAuthorizedDemoSetupRequest(request).pipe(
      Effect.provide(DemoSetupAccess.layer)
    )
  );
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const counts = await setupDemoDatabase({
      catalogSnapshot: catalogFixtureSnapshot,
      reset: new URL(request.url).searchParams.get("reset") === "true",
    });

    return Response.json({ counts, status: "ready" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return Response.json({ message, status: "error" }, { status: 500 });
  }
};
