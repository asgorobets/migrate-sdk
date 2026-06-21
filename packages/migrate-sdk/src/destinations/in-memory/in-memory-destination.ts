import { Effect, Schema } from "effect";
import { DestinationError } from "../../domain/errors.ts";
import type { EncodedSourceIdentity } from "../../domain/ids.ts";
import { EncodedSourceIdentity as EncodedSourceIdentitySchema } from "../../domain/ids.ts";
import {
  DestinationChangeDescriptor,
  type DestinationChangeDescriptor as DestinationChangeDescriptorType,
} from "../../domain/tracking.ts";
import { Tracking } from "../../services/tracking.ts";

export interface InMemoryDestinationTransientFailures {
  readonly execute?: number;
}

export interface InMemoryDestinationEntry<
  ContentType extends string = string,
  Fields extends Schema.JsonObject = Schema.JsonObject,
> {
  readonly contentType: ContentType;
  readonly entryId: string;
  readonly entryVersion: string;
  readonly fields: Fields;
  readonly published: boolean;
  readonly sourceIdentity: EncodedSourceIdentity;
}

interface InMemoryDestinationState<
  ContentType extends string,
  Fields extends Schema.JsonObject,
> {
  readonly entries: Map<string, InMemoryDestinationEntry<ContentType, Fields>>;
  entryVersionCounter: number;
  executeAttempts: number;
}

export interface InMemoryDestinationInspection<
  ContentType extends string = string,
  Fields extends Schema.JsonObject = Schema.JsonObject,
> {
  readonly entries: () => ReadonlyMap<
    string,
    InMemoryDestinationEntry<ContentType, Fields>
  >;
  readonly entry: (
    key: string
  ) => InMemoryDestinationEntry<ContentType, Fields> | undefined;
  readonly executeAttempts: () => number;
}

export interface InMemoryEntryDestinationFixture<
  ContentType extends string,
  Fields extends Schema.JsonObject,
> extends InMemoryDestinationInspection<ContentType, Fields> {
  readonly destination: InMemoryEntryDestinationModule<ContentType, Fields>;
}

export type InMemoryEntryFieldSchema<
  Fields extends Schema.JsonObject = Schema.JsonObject,
> = Schema.Codec<Fields, Fields, never, never>;

type NonEmptyString<Value extends string> = Value extends "" ? never : Value;

export interface InMemoryEntryDestinationModuleOptions<
  ContentType extends string,
  Fields extends Schema.JsonObject,
> {
  readonly contentType: NonEmptyString<ContentType>;
  readonly fields: InMemoryEntryFieldSchema<Fields>;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export interface InMemoryEntryUpsertedChange<
  ContentType extends string = string,
  Fields extends Schema.JsonObject = Schema.JsonObject,
> {
  readonly contentType: ContentType;
  readonly entryId: string;
  readonly entryVersion: string;
  readonly fields: Fields;
  readonly published: boolean;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly [key: string]: Schema.Json;
}

export interface InMemoryEntryDestinationModule<
  ContentType extends string,
  Fields extends Schema.JsonObject,
> {
  readonly changes: {
    readonly entryUpserted: DestinationChangeDescriptorType<
      InMemoryEntryUpsertedChange<ContentType, Fields>
    >;
  };
  readonly entries: {
    readonly upsert: (
      fields: Fields
    ) => Effect.Effect<
      InMemoryDestinationEntry<ContentType, Fields>,
      DestinationError | Schema.SchemaError,
      Tracking
    >;
  };
}

const makeState = <
  ContentType extends string,
  Fields extends Schema.JsonObject,
>(): InMemoryDestinationState<ContentType, Fields> => ({
  entries: new Map(),
  entryVersionCounter: 0,
  executeAttempts: 0,
});

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertTransientFailures = (value: unknown): void => {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    throw new Error(
      "In-memory destination transientFailures must be an object"
    );
  }

  const execute = value.execute;

  if (
    execute !== undefined &&
    (typeof execute !== "number" || !Number.isInteger(execute) || execute < 0)
  ) {
    throw new Error(
      "In-memory destination transientFailures.execute must be a non-negative integer"
    );
  }
};

const assertInMemoryEntryDestinationOptions = <
  ContentType extends string,
  Fields extends Schema.JsonObject,
>(
  options: InMemoryEntryDestinationInternalOptions<ContentType, Fields>
): void => {
  const input = options as unknown;

  if (!isRecord(input)) {
    throw new Error("In-memory entry destination options must be an object");
  }

  if (typeof input.contentType !== "string" || input.contentType.length === 0) {
    throw new Error(
      "In-memory entry destination contentType must be a non-empty string"
    );
  }

  if (!Schema.isSchema(input.fields)) {
    throw new Error("In-memory entry destination requires a fields schema");
  }

  assertTransientFailures(input.transientFailures);
};

interface InMemoryEntryDestinationInternalOptions<
  ContentType extends string,
  Fields extends Schema.JsonObject,
> extends InMemoryEntryDestinationModuleOptions<ContentType, Fields> {
  readonly state?: InMemoryDestinationState<ContentType, Fields>;
}

const makeInspection = <
  ContentType extends string,
  Fields extends Schema.JsonObject,
>(
  state: InMemoryDestinationState<ContentType, Fields>
): InMemoryDestinationInspection<ContentType, Fields> => ({
  entries: () => state.entries,
  entry: (key) => state.entries.get(key),
  executeAttempts: () => state.executeAttempts,
});

const transientDestinationError = (): DestinationError =>
  new DestinationError({
    message: "In-memory destination execute failed transiently",
  });

const inMemoryEntryKey = (
  contentType: string,
  sourceIdentity: EncodedSourceIdentity
) => `${contentType}:${sourceIdentity}`;

const nextEntryVersion = <
  ContentType extends string,
  Fields extends Schema.JsonObject,
>(
  state: InMemoryDestinationState<ContentType, Fields>
): string => {
  state.entryVersionCounter += 1;
  return `version:${state.entryVersionCounter}`;
};

const makeEntriesWithState = <
  const ContentType extends string,
  const Fields extends Schema.JsonObject,
>(
  options: InMemoryEntryDestinationInternalOptions<ContentType, Fields>
): InMemoryEntryDestinationModule<ContentType, Fields> => {
  assertInMemoryEntryDestinationOptions(options);

  const state = options.state ?? makeState<ContentType, Fields>();
  let remainingExecuteFailures = options.transientFailures?.execute ?? 0;
  const entryUpserted = DestinationChangeDescriptor.make(
    `in-memory.entry.${options.contentType}.upserted`,
    Schema.Struct({
      contentType: Schema.Literal(options.contentType),
      entryId: Schema.String,
      entryVersion: Schema.String,
      fields: options.fields,
      published: Schema.Boolean,
      sourceIdentity: EncodedSourceIdentitySchema,
    })
  );

  const upsert = Effect.fn("InMemoryDestination.entries.upsert")(function* (
    fields: Fields
  ) {
    const context = yield* Tracking.currentContext;
    const decodedFields = yield* Schema.decodeUnknownEffect(options.fields, {
      errors: "all",
    })(fields);

    state.executeAttempts += 1;

    if (remainingExecuteFailures > 0) {
      remainingExecuteFailures -= 1;
      yield* Tracking.logDiagnostic({
        severity: "error",
        message: "In-memory destination execute failed transiently",
        details: {
          contentType: options.contentType,
          operation: "entries.upsert",
          sourceIdentity: context.sourceIdentity,
        },
      });
      return yield* transientDestinationError();
    }

    const key = inMemoryEntryKey(options.contentType, context.sourceIdentity);
    const existing = state.entries.get(key);
    const entryId = existing?.entryId ?? `entry:${key}`;
    const entryVersion = nextEntryVersion(state);
    const entry: InMemoryDestinationEntry<ContentType, Fields> = {
      contentType: options.contentType,
      entryId,
      entryVersion,
      fields: decodedFields,
      published: existing?.published ?? false,
      sourceIdentity: context.sourceIdentity,
    };
    const change: InMemoryEntryUpsertedChange<ContentType, Fields> = {
      contentType: options.contentType,
      entryId,
      entryVersion,
      fields: decodedFields,
      published: entry.published,
      sourceIdentity: context.sourceIdentity,
    };

    state.entries.set(key, entry);
    yield* Tracking.recordChange(entryUpserted, change);

    return entry;
  });

  return {
    changes: {
      entryUpserted,
    },
    entries: {
      upsert,
    },
  };
};

const makeEntries = <
  const ContentType extends string,
  const Fields extends Schema.JsonObject,
>(
  options: InMemoryEntryDestinationModuleOptions<ContentType, Fields>
): InMemoryEntryDestinationModule<ContentType, Fields> =>
  makeEntriesWithState(options);

const fixtureEntries = <
  const ContentType extends string,
  const Fields extends Schema.JsonObject,
>(
  options: InMemoryEntryDestinationModuleOptions<ContentType, Fields>
): InMemoryEntryDestinationFixture<ContentType, Fields> => {
  const state = makeState<ContentType, Fields>();
  const destination = makeEntriesWithState({
    ...options,
    state,
  });

  return {
    destination,
    ...makeInspection(state),
  };
};

export const InMemoryDestination = {
  makeEntries,
} as const;

export const InMemoryDestinationTesting = {
  fixtureEntries,
} as const;
