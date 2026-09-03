import type {
  ImportContainer,
  ImportContainerDraft,
} from "@commercetools/importapi-sdk";
import { Clock, Duration, Effect, Schema } from "effect";
import {
  CommercetoolsImportSdk,
  type CommercetoolsImportSdkError,
  type CommercetoolsImportSdkLayer,
} from "./sdk.ts";

const getOperation = "importContainers.get";
const createOperation = "importContainers.create";
const defaultMinimumRemainingLifetime = "1 hour" as const;
const JsonObject = Schema.Record(Schema.String, Schema.Json);

export class CommercetoolsImportContainerContractError extends Schema.TaggedError<CommercetoolsImportContainerContractError>()(
  "CommercetoolsImportContainerContractError",
  {
    details: Schema.optional(JsonObject),
    message: Schema.String,
    operation: Schema.String,
  }
) {}

const contractError = (
  operation: string,
  message: string,
  details?: Schema.JsonObject
): CommercetoolsImportContainerContractError =>
  new CommercetoolsImportContainerContractError({
    ...(details === undefined ? {} : { details }),
    message,
    operation,
  });

export interface CommercetoolsImportContainerEnsureInput
  extends ImportContainerDraft {
  /** Reject an existing container this close to expiry so the caller can rotate its key. */
  readonly minimumRemainingLifetime?: Duration.Input | undefined;
}

const get = Effect.fn("CommercetoolsImportContainers.get")(function* (
  key: string
): Effect.fn.Return<
  ImportContainer | null,
  CommercetoolsImportSdkError | CommercetoolsImportContainerContractError,
  CommercetoolsImportSdk
> {
  if (key.trim().length === 0) {
    return yield* contractError(
      getOperation,
      "Import Container key must not be empty"
    );
  }

  const sdk = yield* CommercetoolsImportSdk;

  return yield* sdk
    .request(getOperation, (project) =>
      project
        .importContainers()
        .withImportContainerKeyValue({ importContainerKey: key })
        .get()
    )
    .pipe(
      Effect.catch((error) =>
        error.statusCode === 404 ? Effect.succeed(null) : Effect.fail(error)
      )
    );
});

const create = Effect.fn("CommercetoolsImportContainers.create")(function* (
  draft: ImportContainerDraft
): Effect.fn.Return<
  ImportContainer,
  CommercetoolsImportSdkError | CommercetoolsImportContainerContractError,
  CommercetoolsImportSdk
> {
  if (draft.key.trim().length === 0) {
    return yield* contractError(
      createOperation,
      "Import Container key must not be empty"
    );
  }

  const sdk = yield* CommercetoolsImportSdk;

  return yield* sdk.request(createOperation, (project) =>
    project.importContainers().post({ body: draft })
  );
});

const validateExisting = Effect.fn(
  "CommercetoolsImportContainers.validateExisting"
)(function* (
  container: ImportContainer,
  input: CommercetoolsImportContainerEnsureInput
): Effect.fn.Return<
  ImportContainer,
  CommercetoolsImportContainerContractError
> {
  if (
    input.resourceType !== undefined &&
    container.resourceType !== undefined &&
    input.resourceType !== container.resourceType
  ) {
    return yield* contractError(
      getOperation,
      "Existing Import Container has an incompatible resource type",
      {
        actualResourceType: container.resourceType,
        expectedResourceType: input.resourceType,
        key: input.key,
      }
    );
  }

  const minimumRemainingLifetime = yield* Effect.try({
    try: () =>
      Duration.toMillis(
        input.minimumRemainingLifetime ?? defaultMinimumRemainingLifetime
      ),
    catch: (cause) =>
      contractError(getOperation, "Invalid minimumRemainingLifetime", {
        cause: String(cause),
        key: input.key,
      }),
  });

  if (
    !Number.isFinite(minimumRemainingLifetime) ||
    minimumRemainingLifetime < 0
  ) {
    return yield* contractError(
      getOperation,
      "minimumRemainingLifetime must be non-negative and finite",
      { key: input.key, minimumRemainingLifetime }
    );
  }

  if (container.expiresAt === undefined) {
    return yield* contractError(
      getOperation,
      "Existing Import Container did not report an expiry time",
      { key: input.key }
    );
  }

  const expiresAt = Date.parse(container.expiresAt);
  const now = yield* Clock.currentTimeMillis;

  if (!Number.isFinite(expiresAt)) {
    return yield* contractError(
      getOperation,
      "Existing Import Container reported an invalid expiry time",
      { expiresAt: container.expiresAt, key: input.key }
    );
  }

  if (expiresAt - now < minimumRemainingLifetime) {
    return yield* contractError(
      getOperation,
      "Existing Import Container expires too soon; rotate to a new container key before submitting",
      {
        expiresAt: container.expiresAt,
        key: input.key,
        minimumRemainingLifetime,
      }
    );
  }

  return container;
});

const ensure = Effect.fn("CommercetoolsImportContainers.ensure")(function* (
  input: CommercetoolsImportContainerEnsureInput
): Effect.fn.Return<
  ImportContainer,
  CommercetoolsImportSdkError | CommercetoolsImportContainerContractError,
  CommercetoolsImportSdk
> {
  const existing = yield* get(input.key);

  if (existing !== null) {
    return yield* validateExisting(existing, input);
  }

  return yield* create({
    key: input.key,
    ...(input.resourceType === undefined
      ? {}
      : { resourceType: input.resourceType }),
    ...(input.retentionPolicy === undefined
      ? {}
      : { retentionPolicy: input.retentionPolicy }),
  });
});

export interface ProvidedCommercetoolsImportContainers {
  readonly create: (
    draft: ImportContainerDraft
  ) => Effect.Effect<
    ImportContainer,
    CommercetoolsImportSdkError | CommercetoolsImportContainerContractError
  >;
  readonly ensure: (
    input: CommercetoolsImportContainerEnsureInput
  ) => Effect.Effect<
    ImportContainer,
    CommercetoolsImportSdkError | CommercetoolsImportContainerContractError
  >;
  readonly get: (
    key: string
  ) => Effect.Effect<
    ImportContainer | null,
    CommercetoolsImportSdkError | CommercetoolsImportContainerContractError
  >;
}

const provide = (
  sdkLayer: CommercetoolsImportSdkLayer
): ProvidedCommercetoolsImportContainers => ({
  create: (draft) => create(draft).pipe(Effect.provide(sdkLayer)),
  ensure: (input) => ensure(input).pipe(Effect.provide(sdkLayer)),
  get: (key) => get(key).pipe(Effect.provide(sdkLayer)),
});

export const CommercetoolsImportContainers = {
  create,
  ensure,
  get,
  provide,
} as const;
