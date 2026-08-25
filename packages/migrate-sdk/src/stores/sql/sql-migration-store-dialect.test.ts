import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { SqlClient, Statement } from "effect/unstable/sql";
import {
  makeSqlMigrationStoreDialect,
  type SqlMigrationStoreDialect,
  type SqlMigrationStoreTableNames,
} from "./sql-migration-store-dialect.ts";

type TestDialect = "clickhouse" | "mssql" | "mysql" | "pg" | "sqlite";

interface SqlCall {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

const names: SqlMigrationStoreTableNames = {
  contracts: "test_contracts",
  cursors: "test_cursors",
  itemStates: "test_item_states",
  latestRuns: "test_latest_runs",
  locks: "test_locks",
  runDefinitions: "test_run_definitions",
  runs: "test_runs",
};

const normalizeSql = (call: SqlCall): string => {
  let text = call.strings[0] ?? "";

  for (let index = 0; index < call.values.length; index++) {
    const value = call.values[index];
    text += `${typeof value === "string" ? value : "?"}${call.strings[index + 1] ?? ""}`;
  }

  return text.replaceAll(/\s+/g, " ").trim().toLowerCase();
};

const makeFakeSqlClient = (dialect: TestDialect) => {
  const calls: SqlCall[] = [];
  let transactionCount = 0;
  const client = (<A>(
    stringsOrIdentifier: TemplateStringsArray | string,
    ...values: readonly unknown[]
  ) => {
    if (typeof stringsOrIdentifier === "string") {
      return stringsOrIdentifier as unknown;
    }

    calls.push({
      strings: Array.from(stringsOrIdentifier),
      values,
    });

    return Effect.succeed([]) as unknown as Statement.Statement<A>;
  }) as SqlClient.SqlClient;

  Object.assign(client, {
    and: () => ({ _tag: "Fragment" }),
    insert: () => ({ _tag: "Insert" }),
    literal: (value: string) => value,
    onDialect: (options: Record<TestDialect, () => unknown>) =>
      options[dialect](),
    onDialectOrElse: (
      options: Partial<Record<TestDialect, () => unknown>> & {
        readonly orElse: () => unknown;
      }
    ) => options[dialect]?.() ?? options.orElse(),
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.sync(() => {
        transactionCount += 1;
      }).pipe(Effect.andThen(effect)),
    update: () => ({ _tag: "Update" }),
    withoutTransforms: () => client,
  });

  return {
    calls,
    client,
    reset: () => {
      calls.length = 0;
    },
    transactionCount: () => transactionCount,
  };
};

const cursorRow = {
  cursorValue: "cursor-1",
  definitionId: "articles",
  definitionKey: "definition-key",
};

const lockRow = {
  createdAt: "2026-08-10T12:00:00.000Z",
  definitionId: "articles",
  definitionKey: "definition-key",
  ownerRunId: "run-1",
  ownerRunKey: "run-key",
  token: "lock-1",
};

const getDialect = (
  dialect: Exclude<TestDialect, "clickhouse">,
  client: SqlClient.SqlClient
): SqlMigrationStoreDialect => {
  const result = makeSqlMigrationStoreDialect(client, names, "test");

  if (result === null) {
    throw new Error(`Expected ${dialect} SQL migration store dialect`);
  }

  return result;
};

describe("SqlMigrationStoreDialect", () => {
  it.effect("uses each vendor's schema initialization syntax", () =>
    Effect.gen(function* () {
      const pg = makeFakeSqlClient("pg");
      const sqlite = makeFakeSqlClient("sqlite");
      const mysql = makeFakeSqlClient("mysql");
      const mssql = makeFakeSqlClient("mssql");
      const pgDialect = getDialect("pg", pg.client);
      const sqliteDialect = getDialect("sqlite", sqlite.client);
      const mysqlDialect = getDialect("mysql", mysql.client);
      const mssqlDialect = getDialect("mssql", mssql.client);

      yield* pgDialect.initialize;
      yield* sqliteDialect.initialize;
      yield* mysqlDialect.initialize;
      yield* mssqlDialect.initialize;

      const pgSql = pg.calls.map(normalizeSql).join(" ");
      const sqliteSql = sqlite.calls.map(normalizeSql).join(" ");
      const mysqlSql = mysql.calls.map(normalizeSql).join(" ");
      const mssqlSql = mssql.calls.map(normalizeSql).join(" ");

      expect(pgSql).toContain("create table if not exists");
      expect(pgSql).toContain("create index if not exists");
      expect(mysqlSql).toContain("create table if not exists");
      expect(mysqlSql).toContain("index test_item_states_status_idx");
      expect(mysqlSql).not.toContain("create index if not exists");
      expect(mssqlSql).toContain("if object_id");
      expect(mssqlSql).toContain("nvarchar(max)");
      expect(mssqlSql).toContain("from sys.indexes");
      for (const statement of [pgSql, sqliteSql, mysqlSql, mssqlSql]) {
        expect(statement).toContain("last_source_inventory_run_key");
        expect(statement).toContain("last_source_inventory_run_id");
        expect(statement).toContain("test_item_states_orphan_idx");
      }
    })
  );

  it.effect("uses bounded vendor-specific orphan keyset queries", () =>
    Effect.gen(function* () {
      const query = {
        afterIdentityKey: "identity-key",
        definitionId: "articles",
        definitionKey: "definition-key",
        limit: 101,
        sourceInventoryRunId: "run-inventory",
        sourceInventoryRunKey: "inventory-key",
      };

      for (const name of ["pg", "sqlite", "mysql", "mssql"] as const) {
        const fake = makeFakeSqlClient(name);
        const dialect = getDialect(name, fake.client);

        fake.reset();
        yield* dialect.listOrphanItemStateRows(query);

        const statement = fake.calls.map(normalizeSql).join(" ");
        expect(statement).toContain("select payload_json");
        expect(statement).toContain("source_identity_key > identity-key");
        expect(statement).toContain("order by source_identity_key");
        expect(statement).toContain(
          "last_source_inventory_run_key <> inventory-key"
        );

        if (name === "mssql") {
          expect(statement).toContain("offset 0 rows fetch next ? rows only");
        } else {
          expect(statement).toContain("limit");
        }
      }
    })
  );

  it.effect("uses PostgreSQL and SQLite conflict clauses", () =>
    Effect.gen(function* () {
      for (const name of ["pg", "sqlite"] as const) {
        const fake = makeFakeSqlClient(name);
        const dialect = getDialect(name, fake.client);

        fake.reset();
        yield* dialect.upsertCursor(cursorRow);
        yield* dialect.tryAcquireLock(lockRow);

        const sql = fake.calls.map(normalizeSql).join(" ");
        expect(sql).toContain("on conflict (definition_key) do update");
        expect(sql).toContain("on conflict (definition_key) do nothing");
        expect(sql).toContain("returning token");
      }
    })
  );

  it.effect("uses MySQL duplicate-key writes and transactional locks", () =>
    Effect.gen(function* () {
      const fake = makeFakeSqlClient("mysql");
      const dialect = getDialect("mysql", fake.client);

      fake.reset();
      yield* dialect.upsertCursor(cursorRow);
      yield* dialect.tryAcquireLock(lockRow);

      const sql = fake.calls.map(normalizeSql).join(" ");
      expect(sql).toContain("on duplicate key update");
      expect(sql).toContain("select owner_run_id, token");
      expect(fake.transactionCount()).toBe(1);
    })
  );

  it.effect("uses SQL Server merge, output, and range-lock clauses", () =>
    Effect.gen(function* () {
      const fake = makeFakeSqlClient("mssql");
      const dialect = getDialect("mssql", fake.client);

      fake.reset();
      yield* dialect.upsertCursor(cursorRow);
      yield* dialect.tryAcquireLock(lockRow);

      const sql = fake.calls.map(normalizeSql).join(" ");
      expect(sql).toContain("merge test_cursors with (holdlock)");
      expect(sql).toContain("output inserted.token");
      expect(sql).toContain("with (updlock, holdlock)");
    })
  );

  it("rejects ClickHouse because it cannot satisfy the store contract", () => {
    const fake = makeFakeSqlClient("clickhouse");

    expect(makeSqlMigrationStoreDialect(fake.client, names, "test")).toBeNull();
  });
});
