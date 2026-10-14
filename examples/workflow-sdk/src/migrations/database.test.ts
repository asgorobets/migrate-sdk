import { createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { PgClient } from "@effect/sql-pg";
import { Effect, Exit, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import { certificate, privateKey } from "../../test/fixtures/postgres-tls";

it("sends the PostgreSQL hostname as TLS SNI without an explicit servername", async () => {
  const serverNames: (string | false | null)[] = [];
  const sockets = new Set<Socket>();
  const tlsServer = createTlsServer(
    { cert: certificate, key: privateKey },
    (socket) => {
      serverNames.push(socket.servername);
      // The fixture checks TLS routing only, then rejects the database session.
      socket.destroy();
    }
  );
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (request) => {
      expect(request).toEqual(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
      socket.write("S");
      tlsServer.emit("connection", socket);
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("PostgreSQL TLS fixture did not bind a TCP port");
    }
    const client = PgClient.layer({
      url: Redacted.make(
        `postgresql://fixture:fixture@localhost:${address.port}/fixture?sslmode=require`
      ),
      ssl: { ca: certificate },
    });
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT 1`;
      }).pipe(Effect.provide(client), Effect.timeout("5 seconds"))
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(serverNames).toEqual(["localhost"]);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
