import { pingDemoDatabase } from "@/server/demo-database";

export const runtime = "nodejs";

export const GET = async (): Promise<Response> => {
  try {
    await pingDemoDatabase();
    return Response.json({ database: "reachable", status: "ok" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return Response.json(
      { database: "unreachable", message, status: "error" },
      { status: 503 }
    );
  }
};
