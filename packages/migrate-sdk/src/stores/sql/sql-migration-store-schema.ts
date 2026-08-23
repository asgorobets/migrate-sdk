import { createHash } from "node:crypto";
import { Effect, Result } from "effect";
import { Migrator, SqlClient } from "effect/unstable/sql";
import { MigrationStoreError } from "../../domain/errors.ts";
import {
  indexDefinitions,
  type SqlMigrationStoreDialect,
  type SqlMigrationStoreTableNames,
} from "./dialects/dialect.ts";
import { makeInitialSqlMigrationStoreSchema } from "./schema/migrations/0001-initial-schema.ts";
import { makeSqlMigrationStoreDialect } from "./sql-migration-store-dialect.ts";
import {
  defaultSqlMigrationStoreTablePrefix,
  makeSqlMigrationStoreSchemaHistoryTableName,
  makeSqlMigrationStoreTableNames,
  sqlMigrationStoreTablePrefixPattern,
} from "./sql-migration-store-names.ts";

export type SqlMigrationStoreSchemaStatus =
  | "not-installed"
  | "current"
  | "upgrade-required"
  | "future"
  | "divergent"
  | "untracked"
  | "partial";

export type SqlMigrationStoreSchemaDatabase =
  | "microsoft-sql-server"
  | "mysql"
  | "postgresql"
  | "sqlite";

export interface SqlMigrationStoreSchemaMigration {
  readonly description: string;
  readonly id: number;
  readonly name: string;
}

export interface SqlMigrationStoreAppliedSchemaMigration {
  readonly id: number;
  readonly name: string;
}

/** A read-only comparison between the installed SQL schema and this SDK. */
export interface SqlMigrationStoreSchemaPlan {
  readonly applied: readonly SqlMigrationStoreAppliedSchemaMigration[];
  readonly currentVersion: number | null;
  readonly database: SqlMigrationStoreSchemaDatabase;
  readonly issues: readonly string[];
  readonly pending: readonly SqlMigrationStoreSchemaMigration[];
  readonly planId: string;
  readonly status: SqlMigrationStoreSchemaStatus;
  readonly tablePrefix: string;
  readonly targetVersion: number;
  readonly warnings: readonly string[];
}

export interface SqlMigrationStoreSchemaContext {
  readonly database: SqlMigrationStoreSchemaDatabase;
  readonly dialect: SqlMigrationStoreDialect;
  readonly historyTable: string;
  readonly names: SqlMigrationStoreTableNames;
  readonly prefix: string;
  readonly sql: SqlClient.SqlClient;
}

interface SqlMigrationStoreSchemaShape {
  readonly columns: Readonly<Record<string, readonly string[]>>;
  readonly indexes: readonly string[];
  readonly tables: readonly string[];
}

interface SqlMigrationStoreSchemaMigrationDefinition
  extends SqlMigrationStoreSchemaMigration {
  readonly effect: Effect.Effect<void, unknown>;
  readonly shape: SqlMigrationStoreSchemaShape;
}

interface SqlMigrationHistoryRow {
  readonly migration_id: unknown;
  readonly name: unknown;
}

interface SqlNamedRow {
  readonly column_name?: unknown;
  readonly index_name?: unknown;
  readonly name?: unknown;
  readonly table_name?: unknown;
}

const schemaHistoryColumns = ["migration_id", "name", "created_at"] as const;

const storeError = (message: string, cause?: unknown): MigrationStoreError =>
  new MigrationStoreError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const schemaV1Shape = (
  names: SqlMigrationStoreTableNames,
  prefix: string
): SqlMigrationStoreSchemaShape => {
  const columns: Readonly<Record<string, readonly string[]>> = {
    [names.contracts]: [
      "definition_key",
      "definition_id",
      "source_identity_contract_fingerprint",
      "source_version_contract_fingerprint",
      "tracking_record_contract_id",
      "tracking_record_contract_fingerprint",
    ],
    [names.cursors]: ["definition_key", "definition_id", "cursor_value"],
    [names.itemStates]: [
      "definition_key",
      "definition_id",
      "source_identity_key",
      "source_identity",
      "status",
      "last_run_key",
      "last_run_id",
      "last_source_inventory_run_key",
      "last_source_inventory_run_id",
      "updated_at",
      "source_version",
      "source_version_contract_fingerprint",
      "error_tag",
      "payload_json",
    ],
    [names.latestRuns]: ["definition_key", "definition_id", "run_key"],
    [names.locks]: [
      "definition_key",
      "definition_id",
      "owner_run_key",
      "owner_run_id",
      "token",
      "created_at",
    ],
    [names.runDefinitions]: [
      "run_key",
      "run_id",
      "definition_key",
      "definition_id",
      "position",
    ],
    [names.runs]: [
      "run_key",
      "run_id",
      "status",
      "started_at",
      "finished_at",
      "execution_adapter",
      "execution_id",
    ],
  };

  return {
    columns,
    indexes: [
      ...indexDefinitions(names, prefix).map(({ name }) => name),
      `${prefix}_item_states_orphan_idx`,
    ],
    tables: Object.keys(columns),
  };
};

const makeMigrations = (
  context: SqlMigrationStoreSchemaContext
): readonly SqlMigrationStoreSchemaMigrationDefinition[] => [
  {
    description: "Create the complete SQL Migration Store schema",
    effect: makeInitialSqlMigrationStoreSchema(
      context.sql,
      context.names,
      context.prefix
    ),
    id: 1,
    name: "initial_schema",
    shape: schemaV1Shape(context.names, context.prefix),
  },
];

const migrationMetadata = (
  migration: SqlMigrationStoreSchemaMigrationDefinition
): SqlMigrationStoreSchemaMigration => ({
  description: migration.description,
  id: migration.id,
  name: migration.name,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const readString = (row: unknown, fields: readonly string[]): string | null => {
  const record = asRecord(row);

  if (record === null) {
    return null;
  }

  for (const field of fields) {
    const value = record[field];

    if (typeof value === "string") {
      return value;
    }
  }

  return null;
};

const readSafeInteger = (value: unknown): number | null => {
  if (
    typeof value !== "bigint" &&
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const makeContext = (
  tablePrefix?: string
): Effect.Effect<
  SqlMigrationStoreSchemaContext,
  MigrationStoreError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms();
    const prefix = tablePrefix ?? defaultSqlMigrationStoreTablePrefix;

    if (!sqlMigrationStoreTablePrefixPattern.test(prefix)) {
      return yield* storeError(
        "SQL migration store table prefix must be a SQL identifier",
        prefix
      );
    }

    const names = makeSqlMigrationStoreTableNames(prefix);
    const dialect = makeSqlMigrationStoreDialect(sql, names);
    const database = sql.onDialect({
      clickhouse: () => null,
      mssql: () => "microsoft-sql-server" as const,
      mysql: () => "mysql" as const,
      pg: () => "postgresql" as const,
      sqlite: () => "sqlite" as const,
    });

    if (dialect === null || database === null) {
      return yield* storeError(
        "SQL Migration Store does not support the configured SQL dialect"
      );
    }

    return {
      database,
      dialect,
      historyTable: makeSqlMigrationStoreSchemaHistoryTableName(prefix),
      names,
      prefix,
      sql,
    };
  });

const runSchemaQuery = <A>(
  operation: string,
  effect: Effect.Effect<A, unknown>
): Effect.Effect<A, MigrationStoreError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      storeError(`Unable to ${operation} for SQL migration store schema`, cause)
    )
  );

const assertTransactionSupport = (
  sql: SqlClient.SqlClient
): Effect.Effect<void, MigrationStoreError> =>
  Effect.sandbox(sql.withTransaction(Effect.void)).pipe(
    Effect.mapError((cause) =>
      storeError("SQL migration store requires transaction support", cause)
    )
  );

const listTables = (
  context: SqlMigrationStoreSchemaContext
): Effect.Effect<ReadonlySet<string>, MigrationStoreError> => {
  const rows = context.sql.onDialect({
    pg: () => context.sql`
      SELECT table_name AS table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
    `,
    mysql: () => context.sql`
      SELECT table_name AS table_name
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
    `,
    mssql: () => context.sql`
      SELECT TABLE_NAME AS table_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = SCHEMA_NAME()
    `,
    sqlite: () => context.sql`
      SELECT name AS table_name
      FROM sqlite_master
      WHERE type = 'table'
    `,
    clickhouse: () => Effect.succeed([]),
  });

  return runSchemaQuery("list tables", rows).pipe(
    Effect.map(
      (result) =>
        new Set(
          result.flatMap((row) => {
            const name = readString(row, ["table_name", "TABLE_NAME", "name"]);
            return name === null ? [] : [name];
          })
        )
    )
  );
};

const listColumns = (
  context: SqlMigrationStoreSchemaContext,
  tables: ReadonlySet<string>
): Effect.Effect<
  ReadonlyMap<string, ReadonlySet<string>>,
  MigrationStoreError
> => {
  if (context.database === "sqlite") {
    return Effect.forEach(tables, (table) =>
      runSchemaQuery(
        `list columns for ${table}`,
        context.sql<SqlNamedRow>`PRAGMA table_info(${context.sql(table)})`
      ).pipe(
        Effect.map(
          (rows) =>
            [
              table,
              new Set(
                rows.flatMap((row) => {
                  const name = readString(row, ["name"]);
                  return name === null ? [] : [name];
                })
              ),
            ] as const
        )
      )
    ).pipe(Effect.map((entries) => new Map(entries)));
  }

  const rows = context.sql.onDialect({
    pg: () => context.sql`
      SELECT table_name AS table_name, column_name AS column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
    `,
    mysql: () => context.sql`
      SELECT table_name AS table_name, column_name AS column_name
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
    `,
    mssql: () => context.sql`
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = SCHEMA_NAME()
    `,
    sqlite: () => Effect.succeed([]),
    clickhouse: () => Effect.succeed([]),
  });

  return runSchemaQuery("list columns", rows).pipe(
    Effect.map((result) => {
      const columns = new Map<string, Set<string>>();

      for (const row of result) {
        const table = readString(row, ["table_name", "TABLE_NAME"]);
        const column = readString(row, ["column_name", "COLUMN_NAME"]);

        if (table !== null && column !== null && tables.has(table)) {
          const names = columns.get(table) ?? new Set<string>();
          names.add(column);
          columns.set(table, names);
        }
      }

      return columns;
    })
  );
};

const listIndexes = (
  context: SqlMigrationStoreSchemaContext
): Effect.Effect<ReadonlySet<string>, MigrationStoreError> => {
  const rows = context.sql.onDialect({
    pg: () => context.sql`
      SELECT indexname AS index_name
      FROM pg_indexes
      WHERE schemaname = current_schema()
    `,
    mysql: () => context.sql`
      SELECT DISTINCT index_name AS index_name
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
    `,
    mssql: () => context.sql`
      SELECT name AS index_name
      FROM sys.indexes
      WHERE name IS NOT NULL
    `,
    sqlite: () => context.sql`
      SELECT name AS index_name
      FROM sqlite_master
      WHERE type = 'index'
    `,
    clickhouse: () => Effect.succeed([]),
  });

  return runSchemaQuery("list indexes", rows).pipe(
    Effect.map(
      (result) =>
        new Set(
          result.flatMap((row) => {
            const name = readString(row, ["index_name", "INDEX_NAME", "name"]);
            return name === null ? [] : [name];
          })
        )
    )
  );
};

const readHistory = (
  context: SqlMigrationStoreSchemaContext
): Effect.Effect<
  readonly SqlMigrationStoreAppliedSchemaMigration[],
  MigrationStoreError
> =>
  runSchemaQuery(
    "read migration history",
    context.sql<SqlMigrationHistoryRow>`
      SELECT migration_id, name
      FROM ${context.sql(context.historyTable)}
      ORDER BY migration_id
    `
  ).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => {
        const id = readSafeInteger(row.migration_id);
        const name = typeof row.name === "string" ? row.name : null;

        return id === null || name === null
          ? Effect.fail(
              storeError(
                "Unable to decode SQL migration store schema history",
                row
              )
            )
          : Effect.succeed({ id, name });
      })
    )
  );

const shapeIssues = (
  shape: SqlMigrationStoreSchemaShape,
  tables: ReadonlySet<string>,
  columns: ReadonlyMap<string, ReadonlySet<string>>,
  indexes: ReadonlySet<string>
): readonly string[] => {
  const issues: string[] = [];

  for (const table of shape.tables) {
    if (!tables.has(table)) {
      issues.push(`Missing table ${table}`);
      continue;
    }

    const installedColumns = columns.get(table) ?? new Set<string>();

    for (const column of shape.columns[table] ?? []) {
      if (!installedColumns.has(column)) {
        issues.push(`Missing column ${table}.${column}`);
      }
    }
  }

  for (const index of shape.indexes) {
    if (!indexes.has(index)) {
      issues.push(`Missing index ${index}`);
    }
  }

  return issues;
};

const historyMatches = (
  applied: readonly SqlMigrationStoreAppliedSchemaMigration[],
  migrations: readonly SqlMigrationStoreSchemaMigrationDefinition[]
): boolean =>
  applied.slice(0, migrations.length).every((migration, index) => {
    const expected = migrations[index];
    return expected?.id === migration.id && expected.name === migration.name;
  });

type SqlMigrationStoreSchemaPlanDetails = Omit<
  SqlMigrationStoreSchemaPlan,
  "database" | "planId" | "tablePrefix" | "warnings"
>;

const schemaWarnings = (
  database: SqlMigrationStoreSchemaDatabase
): readonly string[] =>
  database === "mysql"
    ? [
        "MySQL DDL can commit migration history before every schema change completes; run one schema upgrade at a time and require a current postflight.",
      ]
    : [];

const makePlan = (
  context: SqlMigrationStoreSchemaContext,
  details: SqlMigrationStoreSchemaPlanDetails
): SqlMigrationStoreSchemaPlan => {
  const plan = {
    ...details,
    database: context.database,
    tablePrefix: context.prefix,
    warnings: schemaWarnings(context.database),
  };

  return {
    ...plan,
    planId: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
};

export const planSqlMigrationStoreSchemaWithContext = (
  context: SqlMigrationStoreSchemaContext
): Effect.Effect<SqlMigrationStoreSchemaPlan, MigrationStoreError> =>
  Effect.gen(function* () {
    const migrations = makeMigrations(context);
    const targetVersion = migrations.at(-1)?.id ?? 0;
    const tables = yield* listTables(context);
    const ownedTables = new Set([
      ...migrations.flatMap(({ shape }) => shape.tables),
      context.historyTable,
    ]);
    const installedOwnedTables = new Set(
      [...tables].filter((table) => ownedTables.has(table))
    );
    const hasHistory = tables.has(context.historyTable);

    if (!hasHistory) {
      const dataTables = [...installedOwnedTables].filter(
        (table) => table !== context.historyTable
      );
      const status = dataTables.length === 0 ? "not-installed" : "untracked";
      const issues =
        status === "untracked"
          ? [
              `Found SQL Migration Store tables without ${context.historyTable}: ${dataTables.join(", ")}`,
            ]
          : [];

      return makePlan(context, {
        applied: [],
        currentVersion: null,
        issues,
        pending: migrations.map(migrationMetadata),
        status,
        targetVersion,
      });
    }

    const columns = yield* listColumns(context, installedOwnedTables);
    const historyColumns =
      columns.get(context.historyTable) ?? new Set<string>();
    const missingHistoryColumns = schemaHistoryColumns.filter(
      (column) => !historyColumns.has(column)
    );

    if (missingHistoryColumns.length > 0) {
      return makePlan(context, {
        applied: [],
        currentVersion: null,
        issues: missingHistoryColumns.map(
          (column) => `Missing column ${context.historyTable}.${column}`
        ),
        pending: migrations.map(migrationMetadata),
        status: "partial",
        targetVersion,
      });
    }

    const applied = yield* readHistory(context);
    const currentVersion = applied.at(-1)?.id ?? null;
    const matchingKnownHistory = historyMatches(applied, migrations);
    const knownAppliedCount = Math.min(applied.length, migrations.length);
    const pending = migrations.slice(knownAppliedCount).map(migrationMetadata);

    if (!matchingKnownHistory) {
      return makePlan(context, {
        applied,
        currentVersion,
        issues: ["Installed migration history does not match the SDK history"],
        pending,
        status: "divergent",
        targetVersion,
      });
    }

    if (applied.length === 0) {
      return makePlan(context, {
        applied,
        currentVersion,
        issues: ["Schema history exists but contains no applied migrations"],
        pending: migrations.map(migrationMetadata),
        status: "partial",
        targetVersion,
      });
    }

    if (applied.length > migrations.length) {
      return makePlan(context, {
        applied,
        currentVersion,
        issues: ["Installed schema is newer than this SDK"],
        pending: [],
        status: "future",
        targetVersion,
      });
    }

    const installedMigration = migrations[applied.length - 1];

    if (installedMigration === undefined) {
      return makePlan(context, {
        applied,
        currentVersion,
        issues: ["Installed schema has no matching SDK migration"],
        pending,
        status: "divergent",
        targetVersion,
      });
    }

    const indexes = yield* listIndexes(context);
    const issues = shapeIssues(
      installedMigration.shape,
      tables,
      columns,
      indexes
    );
    let status: SqlMigrationStoreSchemaStatus = "current";

    if (issues.length > 0) {
      status = "partial";
    } else if (applied.length < migrations.length) {
      status = "upgrade-required";
    }

    return makePlan(context, {
      applied,
      currentVersion,
      issues,
      pending,
      status,
      targetVersion,
    });
  });

const applySchemaPlanWithContext = (
  expectedPlan: SqlMigrationStoreSchemaPlan,
  context: SqlMigrationStoreSchemaContext
): Effect.Effect<SqlMigrationStoreSchemaPlan, MigrationStoreError> =>
  Effect.gen(function* () {
    yield* assertTransactionSupport(context.sql);
    const actualPlan = yield* planSqlMigrationStoreSchemaWithContext(context);

    if (actualPlan.planId !== expectedPlan.planId) {
      return yield* storeError(
        "SQL migration store schema changed after the plan was created",
        { actualPlan, expectedPlan }
      );
    }

    if (actualPlan.status === "current") {
      return actualPlan;
    }

    if (
      actualPlan.status !== "not-installed" &&
      actualPlan.status !== "upgrade-required"
    ) {
      return yield* storeError(
        `SQL migration store schema cannot be upgraded from ${actualPlan.status}`,
        actualPlan
      );
    }

    const migrations = makeMigrations(context);
    const record = Object.fromEntries(
      migrations.map((migration) => [
        `${String(migration.id).padStart(4, "0")}_${migration.name}`,
        migration.effect,
      ])
    );
    const migrate = Migrator.make({})({
      loader: Migrator.fromRecord(record),
      table: context.historyTable,
    });

    const migrationResult = yield* Effect.result(
      migrate.pipe(
        Effect.provideService(SqlClient.SqlClient, context.sql),
        Effect.catchDefect((cause) => Effect.fail(cause))
      )
    );
    const completedPlan =
      yield* planSqlMigrationStoreSchemaWithContext(context);

    if (Result.isFailure(migrationResult)) {
      return yield* storeError("Unable to migrate SQL migration store schema", {
        cause: migrationResult.failure,
        postflight: completedPlan,
      });
    }

    if (completedPlan.status !== "current") {
      return yield* storeError(
        "SQL migration store schema is not current after migration",
        completedPlan
      );
    }

    return completedPlan;
  });

/** Inspects schema history and shape without creating or changing SQL objects. */
export const planSqlMigrationStoreSchema = (
  options: { readonly tablePrefix?: string } = {}
): Effect.Effect<
  SqlMigrationStoreSchemaPlan,
  MigrationStoreError,
  SqlClient.SqlClient
> =>
  Effect.flatMap(
    makeContext(options.tablePrefix),
    planSqlMigrationStoreSchemaWithContext
  );

/** Applies the exact inspected plan and then verifies the resulting schema. */
export const applySqlMigrationStoreSchemaPlan = (
  plan: SqlMigrationStoreSchemaPlan
): Effect.Effect<
  SqlMigrationStoreSchemaPlan,
  MigrationStoreError,
  SqlClient.SqlClient
> =>
  Effect.flatMap(makeContext(plan.tablePrefix), (context) =>
    applySchemaPlanWithContext(plan, context)
  );

export const prepareSqlMigrationStore = (options: {
  readonly initialize?: boolean;
  readonly tablePrefix?: string;
}): Effect.Effect<
  SqlMigrationStoreSchemaContext,
  MigrationStoreError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const context = yield* makeContext(options.tablePrefix);
    yield* assertTransactionSupport(context.sql);
    const plan = yield* planSqlMigrationStoreSchemaWithContext(context);

    if (plan.status === "not-installed" && options.initialize !== false) {
      yield* applySchemaPlanWithContext(plan, context);
      return context;
    }

    if (plan.status !== "current") {
      return yield* storeError(
        plan.status === "not-installed"
          ? "SQL migration store schema is not installed"
          : `SQL migration store schema is ${plan.status}`,
        plan
      );
    }

    return context;
  });
