import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { ParseError } from "papaparse";
import Papa from "papaparse";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  defineSourcePluginLayer,
  type SourcePluginImplementation,
} from "../../domain/definition.ts";
import { SourcePluginError } from "../../domain/errors.ts";
import {
  SourceIdentity,
  type SourceIdentityContractIdInput,
  type SourceIdentityDefinition,
  type SourceIdentitySchema,
  type SourceIdentitySnapshotKey,
} from "../../domain/ids.ts";
import {
  makeSourceIdentityContractFingerprint,
  makeSourceVersionContractFingerprint,
} from "../../domain/migration-contract.ts";
import {
  encodeSourceIdentityKey,
  type SourceItemInput,
  SourceItemTotal,
} from "../../domain/source.ts";
import {
  type AnySourcePlugin,
  SourcePlugin,
} from "../../services/source-plugin.ts";

const textEncoder = new TextEncoder();

export type CsvDialect =
  | {
      readonly kind: "standard";
    }
  | {
      readonly kind: "custom";
      readonly separator: string;
    };

export type CsvEmptyRows =
  | {
      readonly kind: "skip";
    }
  | {
      readonly kind: "error";
    };

export type CsvHeaders =
  | {
      readonly kind: "from-row";
      readonly rowIndex: number;
    }
  | {
      readonly kind: "provided";
      readonly columns: readonly string[];
      readonly dataStartRowIndex: number;
    };

export interface CsvIdentityKeySelector {
  readonly columns: readonly string[];
  readonly kind: "columns";
}

export interface CsvIdentityDefinition<
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly id: SourceIdentityContractIdInput;
  readonly key: CsvIdentityKeySelector;
  readonly schema: SourceIdentitySchema<IdentityKey>;
}

export type CsvCompositeIdentityKey = readonly [string, string, ...string[]];

interface CsvColumnIdentityOptions {
  readonly column: string;
  readonly id: SourceIdentityContractIdInput;
}

interface CsvColumnsIdentityOptions {
  readonly columns: readonly [string, string, ...string[]];
  readonly id: SourceIdentityContractIdInput;
}

const makeCsvColumnIdentity = (
  input: CsvColumnIdentityOptions
): CsvIdentityDefinition<string> => ({
  id: input.id,
  key: {
    columns: [input.column],
    kind: "columns",
  },
  schema: SourceIdentity.key(input.column, Schema.NonEmptyString),
});

const makeCsvColumnsIdentity = (
  input: CsvColumnsIdentityOptions
): CsvIdentityDefinition<CsvCompositeIdentityKey> => {
  const [firstColumn, secondColumn, ...remainingColumns] = input.columns;

  return {
    id: input.id,
    key: {
      columns: input.columns,
      kind: "columns",
    },
    schema: SourceIdentity.tuple([
      SourceIdentity.part(firstColumn, Schema.NonEmptyString),
      SourceIdentity.part(secondColumn, Schema.NonEmptyString),
      ...remainingColumns.map((column) =>
        SourceIdentity.part(column, Schema.NonEmptyString)
      ),
    ]),
  };
};

export const CsvIdentity = {
  column: makeCsvColumnIdentity,
  columns: makeCsvColumnsIdentity,
} as const;

export type CsvVersion =
  | {
      readonly kind: "column";
      readonly column: string;
    }
  | {
      readonly kind: "row-hash";
    };

export interface CsvParserOptions<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly dialect: CsvDialect;
  readonly emptyRows: CsvEmptyRows;
  readonly headers: CsvHeaders;
  readonly identity: CsvIdentityDefinition<IdentityKey>;
  readonly version: CsvVersion;
}

export type CsvParserInput = string | Uint8Array;

export type CsvSourcePlatform = Layer.Layer<FileSystem | Path>;

export interface CsvSourceOptions<
  Source,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends CsvParserOptions<IdentityKey> {
  readonly path: string;
  readonly platform: CsvSourcePlatform;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
}

export const CsvSourceCursor = Schema.Struct({
  fileFingerprint: Schema.String,
  nextRowIndex: Schema.Int,
});

export type CsvSourceCursor = typeof CsvSourceCursor.Type;

export interface CsvParsedRow<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly lineNumber: number;
  readonly rowIndex: number;
  readonly sourceItem: SourceItemInput<Record<string, string>, IdentityKey>;
}

export interface CsvParsedDocument<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly columns: readonly string[];
  readonly dataStartRowIndex: number;
  readonly nextRowIndex: number;
  readonly rows: readonly CsvParsedRow<IdentityKey>[];
}

interface LogicalCsvRecord {
  readonly cells: readonly string[];
  readonly lineNumber: number;
  readonly rowIndex: number;
}

interface RawLogicalCsvRecord {
  readonly lineNumber: number;
  readonly text: string;
}

const csvError = (message: string, cause?: unknown): SourcePluginError =>
  new SourcePluginError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const separatorForDialect = (dialect: CsvDialect): string =>
  dialect.kind === "standard" ? "," : dialect.separator;

const separatorForDialectEffect = (
  dialect: CsvDialect
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    const separator = separatorForDialect(dialect);

    if (separator.length === 0) {
      return yield* csvError("CSV separator must not be empty");
    }

    if (Papa.BAD_DELIMITERS.includes(separator)) {
      return yield* csvError("CSV separator is not supported", { separator });
    }

    return separator;
  });

const stripUtf8Bom = (input: string): string =>
  input.startsWith("\uFEFF") ? input.slice(1) : input;

const isNewlineAt = (
  input: string,
  index: number
): { readonly length: 1 | 2 } | null => {
  const character = input[index];

  if (character === "\r") {
    return { length: input[index + 1] === "\n" ? 2 : 1 };
  }

  return character === "\n" ? { length: 1 } : null;
};

const splitLogicalRecords = (input: string): readonly RawLogicalCsvRecord[] => {
  const records: RawLogicalCsvRecord[] = [];
  let startIndex = 0;
  let lineNumber = 1;
  let recordLineNumber = 1;
  let inQuotes = false;
  let index = 0;

  while (index < input.length) {
    const character = input[index];

    if (character === '"') {
      if (inQuotes && input[index + 1] === '"') {
        index += 2;
        continue;
      }

      inQuotes = !inQuotes;
      index += 1;
      continue;
    }

    const newline = isNewlineAt(input, index);

    if (newline === null) {
      index += 1;
      continue;
    }

    if (!inQuotes) {
      records.push({
        lineNumber: recordLineNumber,
        text: input.slice(startIndex, index),
      });
      startIndex = index + newline.length;
      recordLineNumber = lineNumber + 1;
    }

    lineNumber += 1;
    index += newline.length;
  }

  if (startIndex < input.length) {
    records.push({
      lineNumber: recordLineNumber,
      text: input.slice(startIndex),
    });
  }

  return records;
};

const parseLogicalRecords = (
  input: string,
  separator: string
): readonly LogicalCsvRecord[] => {
  const normalizedInput = stripUtf8Bom(input);
  const rawRecords = splitLogicalRecords(normalizedInput);

  return rawRecords.map((record, rowIndex) => {
    if (record.text.length === 0) {
      return {
        cells: [],
        lineNumber: record.lineNumber,
        rowIndex,
      };
    }

    const parsedRecord = Papa.parse<string[]>(record.text, {
      delimiter: separator,
      dynamicTyping: false,
      header: false,
      skipEmptyLines: false,
    });

    if (parsedRecord.errors.length > 0) {
      throw papaParseError(parsedRecord.errors, record, rowIndex);
    }

    if (parsedRecord.data.length !== 1) {
      throw csvError("CSV logical record parsed into multiple rows", {
        lineNumber: record.lineNumber,
        parsedRows: parsedRecord.data.length,
        rowIndex,
      });
    }

    return {
      cells: parsedRecord.data[0] ?? [],
      lineNumber: record.lineNumber,
      rowIndex,
    };
  });
};

const papaParseError = (
  errors: readonly ParseError[],
  record: RawLogicalCsvRecord,
  rowIndex: number
): SourcePluginError =>
  csvError("Unable to parse CSV source", {
    errors: errors.map((error) => ({
      code: error.code,
      message: error.message,
      type: error.type,
      ...(error.index === undefined ? {} : { index: error.index }),
      ...(error.row === undefined ? {} : { parserRow: error.row }),
    })),
    lineNumber: record.lineNumber,
    rowIndex,
  });

const requireNonNegativeInteger = (
  value: number,
  label: string
): Effect.Effect<void, SourcePluginError> =>
  Number.isInteger(value) && value >= 0
    ? Effect.void
    : Effect.fail(
        csvError(`${label} must be a non-negative integer`, { [label]: value })
      );

const normalizeColumnNames = (
  columns: readonly string[],
  context: unknown
): Effect.Effect<readonly string[], SourcePluginError> =>
  Effect.gen(function* () {
    const normalized = columns.map((column) => column.trim());
    const seen = new Map<string, number>();

    if (normalized.length === 0) {
      return yield* csvError("CSV header must include at least one column", {
        ...asCauseObject(context),
      });
    }

    for (const [index, column] of normalized.entries()) {
      if (column.length === 0) {
        return yield* csvError("CSV header column name must not be blank", {
          ...asCauseObject(context),
          columnIndex: index,
        });
      }

      const existingIndex = seen.get(column);

      if (existingIndex !== undefined) {
        return yield* csvError("CSV header column name must be unique", {
          ...asCauseObject(context),
          column,
          firstColumnIndex: existingIndex,
          duplicateColumnIndex: index,
        });
      }

      seen.set(column, index);
    }

    return normalized;
  });

const normalizeConfiguredColumns = (
  columns: readonly string[],
  label: string
): Effect.Effect<readonly string[], SourcePluginError> =>
  Effect.gen(function* () {
    const normalized = columns.map((column) => column.trim());
    const seen = new Set<string>();

    if (normalized.length === 0) {
      return yield* csvError(`${label} must include at least one column`);
    }

    for (const [index, column] of normalized.entries()) {
      if (column.length === 0) {
        return yield* csvError(`${label} column must not be blank`, {
          columnIndex: index,
        });
      }

      if (seen.has(column)) {
        return yield* csvError(`${label} columns must be unique`, { column });
      }

      seen.add(column);
    }

    return normalized;
  });

const asCauseObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const resolveHeader = (
  records: readonly LogicalCsvRecord[],
  headers: CsvHeaders
): Effect.Effect<
  {
    readonly columns: readonly string[];
    readonly dataStartRowIndex: number;
  },
  SourcePluginError
> =>
  Effect.gen(function* () {
    switch (headers.kind) {
      case "from-row": {
        yield* requireNonNegativeInteger(
          headers.rowIndex,
          "headers.from-row.rowIndex"
        );

        const headerRecord = records[headers.rowIndex];

        if (headerRecord === undefined) {
          return yield* csvError("CSV header row was not found", {
            rowIndex: headers.rowIndex,
          });
        }

        const columns = yield* normalizeColumnNames(headerRecord.cells, {
          lineNumber: headerRecord.lineNumber,
          rowIndex: headerRecord.rowIndex,
        });

        return {
          columns,
          dataStartRowIndex: headers.rowIndex + 1,
        };
      }
      case "provided": {
        yield* requireNonNegativeInteger(
          headers.dataStartRowIndex,
          "headers.provided.dataStartRowIndex"
        );

        const columns = yield* normalizeColumnNames(headers.columns, {
          source: "provided",
        });

        return {
          columns,
          dataStartRowIndex: headers.dataStartRowIndex,
        };
      }
      default: {
        const unhandledHeaders: never = headers;
        throw new Error(
          `Unhandled CSV header configuration: ${unhandledHeaders}`
        );
      }
    }
  });

const ensureConfiguredColumnExists = (
  column: string,
  columns: readonly string[],
  label: string
): Effect.Effect<void, SourcePluginError> =>
  columns.includes(column)
    ? Effect.void
    : Effect.fail(
        csvError(`CSV ${label} column was not found`, {
          availableColumns: columns,
          column,
        })
      );

const isBlankRow = (cells: readonly string[]): boolean =>
  cells.every((cell) => cell.trim().length === 0);

const rowWidthMismatchError = (
  record: LogicalCsvRecord,
  columns: readonly string[]
): SourcePluginError =>
  csvError("CSV row width does not match configured columns", {
    actualColumns: record.cells.length,
    expectedColumns: columns.length,
    lineNumber: record.lineNumber,
    rowIndex: record.rowIndex,
  });

const emptyRowError = (record: LogicalCsvRecord): SourcePluginError =>
  csvError("CSV row is blank", {
    lineNumber: record.lineNumber,
    rowIndex: record.rowIndex,
  });

const recordToItem = (
  record: LogicalCsvRecord,
  columns: readonly string[]
): Record<string, string> => {
  const item: Record<string, string> = {};

  for (const [index, column] of columns.entries()) {
    item[column] = record.cells[index] ?? "";
  }

  return item;
};

const buildIdentityKey = (
  item: Record<string, string>,
  columns: readonly string[],
  record: LogicalCsvRecord
): Effect.Effect<unknown, SourcePluginError> =>
  Effect.gen(function* () {
    const values = columns.map((column) => item[column]?.trim() ?? "");

    for (const [index, value] of values.entries()) {
      if (value.length === 0) {
        return yield* csvError("CSV identity value must not be empty", {
          column: columns[index],
          lineNumber: record.lineNumber,
          rowIndex: record.rowIndex,
        });
      }
    }

    if (values.length === 1) {
      const [value] = values;

      if (value === undefined) {
        return yield* csvError("CSV identity value must not be empty", {
          lineNumber: record.lineNumber,
          rowIndex: record.rowIndex,
        });
      }

      return value;
    }

    return values;
  });

const makeCsvIdentityDefinition = <
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  identity: CsvIdentityDefinition<IdentityKey>
): SourceIdentityDefinition<IdentityKey> =>
  SourceIdentity.make({
    id: identity.id,
    schema: identity.schema,
  });

const makeCsvSourceIdentityContractFingerprint = <
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: CsvParserOptions<IdentityKey>,
  identityDefinition: SourceIdentityDefinition<IdentityKey>
) =>
  makeSourceIdentityContractFingerprint({
    dialect: options.dialect,
    headers: options.headers,
    identity: identityDefinition.fingerprint,
    key: options.identity.key,
    source: "csv@v1",
  });

const makeCsvSourceVersionContractFingerprint = (version: CsvVersion) =>
  makeSourceVersionContractFingerprint({
    source: "csv@v1",
    version,
  });

const decodeIdentityKey = <IdentityKey extends SourceIdentitySnapshotKey>(
  identity: SourceIdentityDefinition<IdentityKey>,
  key: unknown,
  record: LogicalCsvRecord
): Effect.Effect<IdentityKey, SourcePluginError> =>
  Effect.try({
    try: () => SourceIdentity.decode(identity, key),
    catch: (cause) =>
      csvError("CSV identity key did not match Source Identity Schema", {
        cause,
        lineNumber: record.lineNumber,
        rowIndex: record.rowIndex,
      }),
  });

const hexFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = (
  bytes: Uint8Array
): Effect.Effect<string, SourcePluginError> =>
  Effect.tryPromise({
    try: async () => {
      const webCrypto = globalThis.crypto;

      if (webCrypto?.subtle !== undefined) {
        const digestInput = new Uint8Array(bytes).buffer;
        const digest = await webCrypto.subtle.digest("SHA-256", digestInput);
        return hexFromBytes(new Uint8Array(digest));
      }

      throw new Error("Web Crypto SHA-256 support is required");
    },
    catch: (cause) => csvError("Unable to hash CSV contents", cause),
  });

const decodeParserInput = (
  input: CsvParserInput
): Effect.Effect<string, SourcePluginError> =>
  typeof input === "string"
    ? Effect.succeed(input)
    : Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(input),
        catch: (cause) =>
          csvError("Unable to decode CSV input as UTF-8", cause),
      });

const buildVersion = (
  item: Record<string, string>,
  columns: readonly string[],
  version: CsvVersion,
  record: LogicalCsvRecord
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    switch (version.kind) {
      case "column": {
        const value = item[version.column]?.trim() ?? "";

        if (value.length === 0) {
          return yield* csvError("CSV version value must not be empty", {
            column: version.column,
            lineNumber: record.lineNumber,
            rowIndex: record.rowIndex,
          });
        }

        return value;
      }
      case "row-hash": {
        const material = JSON.stringify(
          columns.map((column) => [column, item[column] ?? ""])
        );
        return yield* sha256Hex(textEncoder.encode(material));
      }
      default: {
        const unhandledVersion: never = version;
        throw new Error(
          `Unhandled CSV version configuration: ${unhandledVersion}`
        );
      }
    }
  });

const parseDocument = <IdentityKey extends SourceIdentitySnapshotKey>(
  input: CsvParserInput,
  options: CsvParserOptions<IdentityKey>
): Effect.Effect<CsvParsedDocument<IdentityKey>, SourcePluginError> =>
  Effect.gen(function* () {
    const text = yield* decodeParserInput(input);
    const separator = yield* separatorForDialectEffect(options.dialect);
    const records = yield* Effect.try({
      try: () => parseLogicalRecords(text, separator),
      catch: (cause) =>
        cause instanceof SourcePluginError
          ? cause
          : csvError("Unable to parse CSV source", cause),
    });
    const header = yield* resolveHeader(records, options.headers);
    const identityColumns = yield* normalizeConfiguredColumns(
      options.identity.key.columns,
      "CSV identity"
    );

    for (const column of identityColumns) {
      yield* ensureConfiguredColumnExists(column, header.columns, "identity");
    }

    const version: CsvVersion =
      options.version.kind === "column"
        ? {
            kind: "column",
            column: options.version.column.trim(),
          }
        : options.version;

    if (version.kind === "column") {
      if (version.column.length === 0) {
        return yield* csvError("CSV version column must not be blank");
      }

      yield* ensureConfiguredColumnExists(
        version.column,
        header.columns,
        "version"
      );
    }

    const rows: CsvParsedRow<IdentityKey>[] = [];
    const identityRows = new Map<string, CsvParsedRow<IdentityKey>>();
    const identityDefinition = makeCsvIdentityDefinition(options.identity);

    for (const record of records) {
      if (record.rowIndex < header.dataStartRowIndex) {
        continue;
      }

      if (isBlankRow(record.cells)) {
        if (options.emptyRows.kind === "error") {
          return yield* emptyRowError(record);
        }

        continue;
      }

      if (record.cells.length !== header.columns.length) {
        return yield* rowWidthMismatchError(record, header.columns);
      }

      const item = recordToItem(record, header.columns);
      const rawIdentityKey = yield* buildIdentityKey(
        item,
        identityColumns,
        record
      );
      const identityKey = yield* decodeIdentityKey(
        identityDefinition,
        rawIdentityKey,
        record
      );
      const sourceVersion = yield* buildVersion(
        item,
        header.columns,
        version,
        record
      );
      const sourceItem = {
        identityKey,
        item,
        version: sourceVersion,
      } satisfies SourceItemInput<Record<string, string>, IdentityKey>;
      const parsedRow: CsvParsedRow<IdentityKey> = {
        lineNumber: record.lineNumber,
        rowIndex: record.rowIndex,
        sourceItem,
      };
      const encodedIdentity = yield* encodeSourceIdentityKey(
        identityDefinition,
        identityKey
      );
      const existingRow = identityRows.get(encodedIdentity);

      if (existingRow !== undefined) {
        return yield* csvError("Duplicate CSV source identity", {
          duplicateLineNumber: parsedRow.lineNumber,
          duplicateRowIndex: parsedRow.rowIndex,
          firstLineNumber: existingRow.lineNumber,
          firstRowIndex: existingRow.rowIndex,
          sourceIdentity: encodedIdentity,
        });
      }

      identityRows.set(encodedIdentity, parsedRow);
      rows.push(parsedRow);
    }

    return {
      columns: header.columns,
      dataStartRowIndex: header.dataStartRowIndex,
      nextRowIndex: records.length,
      rows,
    };
  });

const readFileBytes = (
  fs: FileSystem,
  path: Path,
  filePath: string
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly resolvedPath: string },
  SourcePluginError
> => {
  const resolvedPath = path.resolve(filePath);

  return fs.readFile(resolvedPath).pipe(
    Effect.map((bytes) => ({
      bytes,
      resolvedPath,
    })),
    Effect.mapError((cause) =>
      csvError("Unable to read CSV source file", {
        cause,
        path: filePath,
        resolvedPath,
      })
    )
  );
};

const decodeUtf8 = (
  bytes: Uint8Array,
  resolvedPath: string
): Effect.Effect<string, SourcePluginError> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      csvError("Unable to decode CSV source file as UTF-8", {
        cause,
        path: resolvedPath,
      }),
  });

const loadPathDocument = <IdentityKey extends SourceIdentitySnapshotKey>(
  fs: FileSystem,
  path: Path,
  options: CsvSourceOptions<unknown, IdentityKey>
): Effect.Effect<
  CsvParsedDocument<IdentityKey> & {
    readonly fileFingerprint: string;
    readonly resolvedPath: string;
  },
  SourcePluginError
> =>
  Effect.gen(function* () {
    const file = yield* readFileBytes(fs, path, options.path);
    const fileFingerprint = yield* sha256Hex(file.bytes);
    const text = yield* decodeUtf8(file.bytes, file.resolvedPath);
    const document = yield* parseDocument(text, options);

    return {
      ...document,
      fileFingerprint,
      resolvedPath: file.resolvedPath,
    };
  });

const makeImplementation = <
  Source,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: CsvSourceOptions<Source, IdentityKey>,
  fs: FileSystem,
  path: Path
): SourcePluginImplementation<
  Source,
  CsvSourceCursor,
  IdentityKey,
  unknown
> => {
  const load = () => loadPathDocument(fs, path, options);
  const identity = makeCsvIdentityDefinition(options.identity);
  const discoverSourceItemTotal = Effect.fn(
    "CsvSource.discoverSourceItemTotal"
  )(() =>
    load().pipe(
      Effect.map((document) => SourceItemTotal.known(document.rows.length)),
      Effect.catch((error) =>
        Effect.succeed(
          SourceItemTotal.unknown({
            cause: error,
            message: "CSV Source Item total discovery failed",
            reason: "failed",
          })
        )
      )
    )
  );

  const read = Effect.fn("CsvSource.read")(function* (
    cursor: CsvSourceCursor | null
  ) {
    const document = yield* load();
    const startRowIndex =
      cursor?.fileFingerprint === document.fileFingerprint
        ? Math.max(cursor.nextRowIndex, document.dataStartRowIndex)
        : document.dataStartRowIndex;
    const rows = document.rows.filter((row) => row.rowIndex >= startRowIndex);
    const shouldAdvanceCursor = startRowIndex < document.nextRowIndex;

    return {
      items: rows.map((row) => row.sourceItem),
      ...(shouldAdvanceCursor
        ? {
            nextCursor: {
              fileFingerprint: document.fileFingerprint,
              nextRowIndex: document.nextRowIndex,
            } satisfies CsvSourceCursor,
          }
        : {}),
    };
  });

  const readByIdentity = Effect.fn("CsvSource.readByIdentity")(function* (
    target: SourceIdentity<IdentityKey>
  ) {
    const document = yield* load();

    for (const candidate of document.rows) {
      const encodedIdentity = yield* encodeSourceIdentityKey(
        identity,
        candidate.sourceItem.identityKey
      );

      if (encodedIdentity === target.encoded) {
        return candidate.sourceItem;
      }
    }

    return null;
  });

  return {
    discoverSourceItemTotal,
    lookupStrategy: "scan",
    read,
    readByIdentity,
  };
};

const makeLayerWithoutPlatform = <
  Source,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: CsvSourceOptions<Source, IdentityKey>
): Layer.Layer<AnySourcePlugin, never, FileSystem | Path> =>
  Layer.effect(
    SourcePlugin,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const identityDefinition = makeCsvIdentityDefinition(options.identity);
      const configured = defineSourcePlugin({
        cursorSchema: CsvSourceCursor,
        identity: identityDefinition,
        make: () => makeImplementation(options, fs, path),
        sourceIdentityContractFingerprint:
          makeCsvSourceIdentityContractFingerprint(options, identityDefinition),
        sourceSchema: options.sourceSchema,
        sourceVersionContractFingerprint:
          makeCsvSourceVersionContractFingerprint(options.version),
      });

      return yield* SourcePlugin.pipe(Effect.provide(configured.layer));
    })
  );

const makeLayer = <Source, IdentityKey extends SourceIdentitySnapshotKey>(
  options: CsvSourceOptions<Source, IdentityKey>
): Layer.Layer<AnySourcePlugin> =>
  makeLayerWithoutPlatform(options).pipe(Layer.provide(options.platform));

const make = <Source, IdentityKey extends SourceIdentitySnapshotKey>(
  options: CsvSourceOptions<Source, IdentityKey>
): ConfiguredSourcePlugin<Source, CsvSourceCursor, IdentityKey, unknown> => {
  const identityDefinition = makeCsvIdentityDefinition(options.identity);

  return defineSourcePluginLayer({
    identity: identityDefinition,
    layer: makeLayer(options),
    sourceIdentityContractFingerprint: makeCsvSourceIdentityContractFingerprint(
      options,
      identityDefinition
    ),
    sourceSchema: options.sourceSchema,
    sourceVersionContractFingerprint: makeCsvSourceVersionContractFingerprint(
      options.version
    ),
  });
};

export const CsvParserCore = {
  parse: parseDocument,
} as const;

export const CsvSourcePlugin = {
  make,
} as const;
