import type {
  ErrorObject,
  ImportOperation,
  ImportResponse,
  ProductDraftImport,
  UnresolvedReferences,
} from "@commercetools/importapi-sdk";
import { Clock, Duration, Effect, Schema } from "effect";
import {
  DestinationChangeDescriptor,
  type DestinationJournal,
  DestinationJournalExtension,
  ProcessBatchContractError,
  Tracking,
} from "migrate-sdk";
import {
  CommercetoolsImportSdk,
  type CommercetoolsImportSdkError,
  type CommercetoolsImportSdkLayer,
  type CommercetoolsImportSdkService,
} from "./sdk.ts";

const submitOperation = "productDrafts.import";
const pollOperation = "importOperations.get";
const providerResourceLimit = 20;
const providerRequestBodyLimitBytes = 14_000_000;
const defaultPollInterval = "1 second" as const;
const defaultPollTimeout = "30 seconds" as const;
const pollConcurrency = 10;
const defaultSubmissionConcurrency = 4;

const JsonObject = Schema.Record(Schema.String, Schema.Json);

export class CommercetoolsImportContractError extends Schema.TaggedError<CommercetoolsImportContractError>()(
  "CommercetoolsImportContractError",
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
): CommercetoolsImportContractError =>
  new CommercetoolsImportContractError({
    ...(details === undefined ? {} : { details }),
    message,
    operation,
  });

const toProcessBatchContractError = (
  error: CommercetoolsImportContractError
): ProcessBatchContractError =>
  new ProcessBatchContractError({
    cause: {
      adapter: "commercetools-import-api",
      ...(error.details === undefined ? {} : { details: error.details }),
      operation: error.operation,
    },
    message: error.message,
  });

export type CommercetoolsProductDraftImportFailedState =
  | "canceled"
  | "partiallyImported"
  | "rejected"
  | "validationFailed";

export type CommercetoolsProductDraftImportPendingState =
  | "processing"
  | "unresolved"
  | "waitForMasterVariant";

export type CommercetoolsProductDraftImportAcceptance =
  | "accepted"
  | "not-accepted"
  | "unknown";

const ProductDraftImportCandidateGroupFields = {
  candidateOperationIds: Schema.Array(Schema.String),
  candidateResourceKeys: Schema.Array(Schema.String),
  resourceKey: Schema.String,
} as const;

export const CommercetoolsProductDraftImportCandidateGroup = Schema.Struct(
  ProductDraftImportCandidateGroupFields
);
export type CommercetoolsProductDraftImportCandidateGroup =
  typeof CommercetoolsProductDraftImportCandidateGroup.Type;

const makeCandidateGroup = (
  candidate: CommercetoolsProductDraftImportCandidateGroup
): CommercetoolsProductDraftImportCandidateGroup => ({
  candidateOperationIds: [...candidate.candidateOperationIds],
  candidateResourceKeys: [...candidate.candidateResourceKeys],
  resourceKey: candidate.resourceKey,
});

interface CommercetoolsProductDraftImportOutcomeBase {
  readonly containerKey: string;
  readonly operationId: string;
  readonly resourceKey: string;
}

export interface CommercetoolsProductDraftImportedOutcome
  extends CommercetoolsProductDraftImportOutcomeBase {
  readonly kind: "imported";
  readonly resourceVersion: number;
  readonly state: "imported";
}

export interface CommercetoolsProductDraftImportFailedOutcome
  extends CommercetoolsProductDraftImportOutcomeBase {
  readonly errors: readonly ErrorObject[];
  readonly kind: "failed";
  readonly resourceVersion?: number | undefined;
  readonly state: CommercetoolsProductDraftImportFailedState;
}

export interface CommercetoolsProductDraftImportPendingOutcome
  extends CommercetoolsProductDraftImportOutcomeBase {
  readonly kind: "pending";
  readonly state: CommercetoolsProductDraftImportPendingState;
  readonly unresolvedReferences?: readonly UnresolvedReferences[] | undefined;
}

export type CommercetoolsProductDraftImportIndeterminateOutcome =
  CommercetoolsProductDraftImportCandidateGroup & {
    readonly acceptance: CommercetoolsProductDraftImportAcceptance;
    readonly containerKey: string;
    readonly kind: "indeterminate";
    readonly message: string;
    readonly state: "pollFailed" | "submissionFailed";
  };

export type CommercetoolsProductDraftImportOutcome =
  | CommercetoolsProductDraftImportedOutcome
  | CommercetoolsProductDraftImportFailedOutcome
  | CommercetoolsProductDraftImportIndeterminateOutcome
  | CommercetoolsProductDraftImportPendingOutcome;

export type CommercetoolsProductDraftImportOutcomes = ReadonlyMap<
  string,
  CommercetoolsProductDraftImportOutcome
>;

export interface CommercetoolsProductDraftImportInput {
  readonly containerKey: string;
  /** Primarily useful for testing; values above the provider limit are rejected. */
  readonly maxRequestBodyBytes?: number | undefined;
  readonly pollInterval?: Duration.Input | undefined;
  readonly pollTimeout?: Duration.Input | undefined;
  readonly resources: readonly ProductDraftImport[];
  readonly submissionConcurrency?: number | undefined;
}

export type CommercetoolsProductDraftImportCandidate = Omit<
  CommercetoolsProductDraftImportCandidateGroup,
  "candidateResourceKeys"
> & {
  /** Resource keys that the ambiguous operation ids are allowed to resolve to. */
  readonly candidateResourceKeys?: readonly string[] | undefined;
};

const normalizeCandidateGroup = (
  candidate: CommercetoolsProductDraftImportCandidate
): CommercetoolsProductDraftImportCandidateGroup =>
  makeCandidateGroup({
    candidateOperationIds: candidate.candidateOperationIds,
    candidateResourceKeys: candidate.candidateResourceKeys ?? [
      candidate.resourceKey,
    ],
    resourceKey: candidate.resourceKey,
  });

export interface CommercetoolsProductDraftAwaitInput {
  readonly candidates: readonly CommercetoolsProductDraftImportCandidate[];
  readonly containerKey: string;
  readonly pollInterval?: Duration.Input | undefined;
  readonly pollTimeout?: Duration.Input | undefined;
}

const ImportOperationIssue = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type CommercetoolsImportOperationIssue =
  typeof ImportOperationIssue.Type;

const NonImportedProcessingState = Schema.Literals([
  "canceled",
  "partiallyImported",
  "pollFailed",
  "processing",
  "rejected",
  "submissionFailed",
  "unresolved",
  "validationFailed",
  "waitForMasterVariant",
]);

export class CommercetoolsImportOperationError extends Schema.TaggedError<CommercetoolsImportOperationError>()(
  "CommercetoolsImportOperationError",
  {
    acceptance: Schema.optional(
      Schema.Literals(["accepted", "not-accepted", "unknown"])
    ),
    ...ProductDraftImportCandidateGroupFields,
    containerKey: Schema.String,
    issues: Schema.Array(ImportOperationIssue),
    message: Schema.String,
    operationId: Schema.optional(Schema.String),
    outcomeKind: Schema.Literals(["failed", "indeterminate", "pending"]),
    resourceType: Schema.Literal("product-draft"),
    resourceVersion: Schema.optional(Schema.Finite),
    state: NonImportedProcessingState,
  }
) {}

const operationError = (
  outcome: Exclude<
    CommercetoolsProductDraftImportOutcome,
    CommercetoolsProductDraftImportedOutcome
  >
): CommercetoolsImportOperationError => {
  if (outcome.kind === "indeterminate") {
    return new CommercetoolsImportOperationError({
      acceptance: outcome.acceptance,
      ...makeCandidateGroup(outcome),
      containerKey: outcome.containerKey,
      issues: [],
      message: outcome.message,
      outcomeKind: outcome.kind,
      resourceType: "product-draft",
      state: outcome.state,
    });
  }

  return new CommercetoolsImportOperationError({
    acceptance: "accepted",
    ...makeCandidateGroup({
      candidateOperationIds: [outcome.operationId],
      candidateResourceKeys: [outcome.resourceKey],
      resourceKey: outcome.resourceKey,
    }),
    containerKey: outcome.containerKey,
    issues:
      outcome.kind === "failed"
        ? outcome.errors.map((error) => ({
            code: error.code,
            message: error.message,
          }))
        : [],
    message:
      outcome.kind === "failed"
        ? `Commercetools Product Draft import failed in state ${outcome.state}`
        : `Commercetools Product Draft import did not finish before the polling deadline; last state was ${outcome.state}`,
    operationId: outcome.operationId,
    outcomeKind: outcome.kind,
    resourceType: "product-draft",
    ...(outcome.kind === "failed" && outcome.resourceVersion !== undefined
      ? { resourceVersion: outcome.resourceVersion }
      : {}),
    state: outcome.state,
  });
};

const ProductDraftImportedChange = Schema.Struct({
  containerKey: Schema.String,
  operationId: Schema.String,
  resourceKey: Schema.String,
  resourceType: Schema.Literal("product-draft"),
  resourceVersion: Schema.Finite,
  state: Schema.Literal("imported"),
});
export type CommercetoolsProductDraftImportedChange =
  typeof ProductDraftImportedChange.Type;

const ProductDraftPartiallyImportedChange = Schema.Struct({
  containerKey: Schema.String,
  issues: Schema.Array(ImportOperationIssue),
  operationId: Schema.String,
  resourceKey: Schema.String,
  resourceType: Schema.Literal("product-draft"),
  resourceVersion: Schema.NullOr(Schema.Finite),
  state: Schema.Literal("partiallyImported"),
});
export type CommercetoolsProductDraftPartiallyImportedChange =
  typeof ProductDraftPartiallyImportedChange.Type;

const ProductDraftPendingOperationReceipt = Schema.Struct({
  containerKey: Schema.String,
  operationId: Schema.String,
  resourceKey: Schema.String,
  resourceType: Schema.Literal("product-draft"),
  state: Schema.Literals(["processing", "unresolved", "waitForMasterVariant"]),
});
export type CommercetoolsProductDraftPendingOperationReceipt =
  typeof ProductDraftPendingOperationReceipt.Type;

const ProductDraftFailedOperationReceipt = Schema.Struct({
  containerKey: Schema.String,
  issues: Schema.Array(ImportOperationIssue),
  operationId: Schema.String,
  resourceKey: Schema.String,
  resourceType: Schema.Literal("product-draft"),
  resourceVersion: Schema.NullOr(Schema.Finite),
  state: Schema.Literals([
    "canceled",
    "partiallyImported",
    "rejected",
    "validationFailed",
  ]),
});
export type CommercetoolsProductDraftFailedOperationReceipt =
  typeof ProductDraftFailedOperationReceipt.Type;

const ProductDraftIndeterminateOperationReceipt = Schema.Struct({
  acceptance: Schema.Literals(["accepted", "not-accepted", "unknown"]),
  ...ProductDraftImportCandidateGroupFields,
  containerKey: Schema.String,
  message: Schema.String,
  resourceType: Schema.Literal("product-draft"),
  state: Schema.Literals(["pollFailed", "submissionFailed"]),
});
export type CommercetoolsProductDraftIndeterminateOperationReceipt =
  typeof ProductDraftIndeterminateOperationReceipt.Type;

const productDraftImportChanges = {
  imported: DestinationChangeDescriptor.make(
    "commercetools.product-draft.imported",
    ProductDraftImportedChange
  ),
  partiallyImported: DestinationChangeDescriptor.make(
    "commercetools.product-draft.partially-imported",
    ProductDraftPartiallyImportedChange
  ),
} as const;

const ProductDraftImportJournalExtensionValue = Schema.Union([
  ProductDraftFailedOperationReceipt,
  ProductDraftImportedChange,
  ProductDraftIndeterminateOperationReceipt,
  ProductDraftPendingOperationReceipt,
]);
export type CommercetoolsProductDraftImportJournalExtensionValue =
  typeof ProductDraftImportJournalExtensionValue.Type;

const productDraftImportOperation = DestinationJournalExtension.make(
  "commercetools.product-draft.import-operation@v1",
  ProductDraftImportJournalExtensionValue
);

const journalValueFromOutcome = (
  outcome: CommercetoolsProductDraftImportOutcome
): CommercetoolsProductDraftImportJournalExtensionValue => {
  if (outcome.kind === "imported") {
    return {
      containerKey: outcome.containerKey,
      operationId: outcome.operationId,
      resourceKey: outcome.resourceKey,
      resourceType: "product-draft",
      resourceVersion: outcome.resourceVersion,
      state: outcome.state,
    };
  }

  if (outcome.kind === "failed") {
    return {
      containerKey: outcome.containerKey,
      issues: outcome.errors.map(({ code, message }) => ({ code, message })),
      operationId: outcome.operationId,
      resourceKey: outcome.resourceKey,
      resourceType: "product-draft",
      resourceVersion: outcome.resourceVersion ?? null,
      state: outcome.state,
    };
  }

  if (outcome.kind === "pending") {
    return {
      containerKey: outcome.containerKey,
      operationId: outcome.operationId,
      resourceKey: outcome.resourceKey,
      resourceType: "product-draft",
      state: outcome.state,
    };
  }

  return {
    acceptance: outcome.acceptance,
    ...makeCandidateGroup(outcome),
    containerKey: outcome.containerKey,
    message: outcome.message,
    resourceType: "product-draft",
    state: outcome.state,
  };
};

const recordOperationOutcome = (
  outcome: CommercetoolsProductDraftImportOutcome
) =>
  Tracking.setExtension(
    productDraftImportOperation,
    journalValueFromOutcome(outcome)
  );

const resumeFromExtensionValue = (
  value: CommercetoolsProductDraftImportJournalExtensionValue,
  resourceKey: string
): CommercetoolsProductDraftImportResume => {
  if (
    value.state === "processing" ||
    value.state === "unresolved" ||
    value.state === "waitForMasterVariant"
  ) {
    return {
      ...makeCandidateGroup({
        candidateOperationIds: [value.operationId],
        candidateResourceKeys: [resourceKey],
        resourceKey,
      }),
      kind: "await",
    };
  }

  if (value.state !== "pollFailed" && value.state !== "submissionFailed") {
    return { kind: "submit" };
  }

  if (
    value.acceptance === "accepted" &&
    value.candidateOperationIds.length > 0
  ) {
    return {
      ...makeCandidateGroup(value),
      kind: "await",
    };
  }

  return value.acceptance === "not-accepted"
    ? { kind: "submit" }
    : {
        kind: "blocked",
        outcome: {
          acceptance: value.acceptance,
          ...makeCandidateGroup(value),
          containerKey: value.containerKey,
          kind: "indeterminate",
          message: value.message,
          state: value.state,
        },
      };
};

export type CommercetoolsProductDraftImportResume =
  | (CommercetoolsProductDraftImportCandidateGroup & {
      readonly kind: "await";
    })
  | {
      readonly kind: "blocked";
      readonly outcome: CommercetoolsProductDraftImportIndeterminateOutcome;
    }
  | { readonly kind: "submit" };

const resumeFromJournal = Effect.fn(
  "CommercetoolsProductDraftImports.resumeFromJournal"
)(function* (
  journal: DestinationJournal | undefined,
  resourceKey: string
): Effect.fn.Return<CommercetoolsProductDraftImportResume, Schema.SchemaError> {
  if (journal === undefined) {
    return { kind: "submit" };
  }

  const extensionValue = yield* productDraftImportOperation.read(journal);

  if (extensionValue !== undefined) {
    yield* Schema.decodeUnknownEffect(
      Schema.Struct({ resourceKey: Schema.Literal(resourceKey) }),
      { errors: "all" }
    )(extensionValue);
    return resumeFromExtensionValue(extensionValue, resourceKey);
  }

  return { kind: "submit" };
});

const durationMillis = (
  operation: string,
  name: string,
  value: Duration.Input,
  options: { readonly allowZero: boolean }
): Effect.Effect<number, CommercetoolsImportContractError> =>
  Effect.try({
    try: () => Duration.toMillis(value),
    catch: (cause) =>
      contractError(operation, `Invalid ${name}`, {
        cause: String(cause),
        name,
      }),
  }).pipe(
    Effect.flatMap((millis) => {
      const validMinimum = options.allowZero ? millis >= 0 : millis > 0;

      return Number.isFinite(millis) && validMinimum
        ? Effect.succeed(millis)
        : Effect.fail(
            contractError(
              operation,
              `${name} must be ${options.allowZero ? "non-negative" : "positive"} and finite`,
              { millis, name }
            )
          );
    })
  );

interface ValidatedPollInput {
  readonly containerKey: string;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly resourceKeys: ReadonlySet<string>;
}

interface ValidatedProductDraftImportInput extends ValidatedPollInput {
  readonly chunks: readonly (readonly ProductDraftImport[])[];
  readonly submissionConcurrency: number;
}

const validatePollOptions = Effect.fn(
  "CommercetoolsProductDraftImports.validatePollOptions"
)(function* (input: {
  readonly containerKey: string;
  readonly operation: string;
  readonly pollInterval?: Duration.Input | undefined;
  readonly pollTimeout?: Duration.Input | undefined;
  readonly resourceKeys: ReadonlySet<string>;
}): Effect.fn.Return<ValidatedPollInput, CommercetoolsImportContractError> {
  if (input.containerKey.trim().length === 0) {
    return yield* contractError(
      input.operation,
      "Import Container key must not be empty"
    );
  }

  const pollIntervalMs = yield* durationMillis(
    input.operation,
    "poll.interval",
    input.pollInterval ?? defaultPollInterval,
    { allowZero: false }
  );
  const pollTimeoutMs = yield* durationMillis(
    input.operation,
    "poll.timeout",
    input.pollTimeout ?? defaultPollTimeout,
    { allowZero: true }
  );

  return {
    containerKey: input.containerKey,
    pollIntervalMs,
    pollTimeoutMs,
    resourceKeys: input.resourceKeys,
  };
});

const requestBodyBytes = (resources: readonly ProductDraftImport[]): number =>
  new TextEncoder().encode(JSON.stringify({ resources, type: "product-draft" }))
    .byteLength;

const chunkResources = (
  resources: readonly ProductDraftImport[],
  maxRequestBodyBytes: number
): Effect.Effect<
  readonly (readonly ProductDraftImport[])[],
  CommercetoolsImportContractError
> =>
  Effect.gen(function* () {
    const chunks: ProductDraftImport[][] = [];
    let current: ProductDraftImport[] = [];

    for (const resource of resources) {
      const candidate = [...current, resource];
      const exceedsCount = candidate.length > providerResourceLimit;
      const exceedsBytes = requestBodyBytes(candidate) > maxRequestBodyBytes;

      if (exceedsCount || exceedsBytes) {
        if (current.length === 0) {
          return yield* contractError(
            submitOperation,
            `Product Draft import resource exceeds the ${maxRequestBodyBytes} byte request-body limit`,
            {
              maxRequestBodyBytes,
              resourceKey: resource.key,
              requestBodyBytes: requestBodyBytes([resource]),
            }
          );
        }

        chunks.push(current);
        current = [resource];

        if (requestBodyBytes(current) > maxRequestBodyBytes) {
          return yield* contractError(
            submitOperation,
            `Product Draft import resource exceeds the ${maxRequestBodyBytes} byte request-body limit`,
            {
              maxRequestBodyBytes,
              resourceKey: resource.key,
              requestBodyBytes: requestBodyBytes(current),
            }
          );
        }
      } else {
        current = candidate;
      }
    }

    if (current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  });

const validateImportInput = Effect.fn(
  "CommercetoolsProductDraftImports.validateImportInput"
)(function* (
  input: CommercetoolsProductDraftImportInput
): Effect.fn.Return<
  ValidatedProductDraftImportInput,
  CommercetoolsImportContractError
> {
  if (input.resources.length === 0) {
    return yield* contractError(
      submitOperation,
      "Product Draft import requires at least one resource"
    );
  }

  const resourceKeys = new Set<string>();

  for (const resource of input.resources) {
    if (resource.key.trim().length === 0) {
      return yield* contractError(
        submitOperation,
        "Product Draft import resource keys must not be empty"
      );
    }

    if (resourceKeys.has(resource.key)) {
      return yield* contractError(
        submitOperation,
        `Duplicate Product Draft import resource key: ${resource.key}`,
        { resourceKey: resource.key }
      );
    }

    resourceKeys.add(resource.key);
  }

  const maxRequestBodyBytes =
    input.maxRequestBodyBytes ?? providerRequestBodyLimitBytes;

  if (
    !Number.isInteger(maxRequestBodyBytes) ||
    maxRequestBodyBytes <= 0 ||
    maxRequestBodyBytes > providerRequestBodyLimitBytes
  ) {
    return yield* contractError(
      submitOperation,
      `maxRequestBodyBytes must be a positive integer no greater than ${providerRequestBodyLimitBytes}`,
      { maxRequestBodyBytes }
    );
  }

  const submissionConcurrency =
    input.submissionConcurrency ?? defaultSubmissionConcurrency;

  if (!Number.isInteger(submissionConcurrency) || submissionConcurrency <= 0) {
    return yield* contractError(
      submitOperation,
      "submissionConcurrency must be a positive integer",
      { submissionConcurrency }
    );
  }

  const poll = yield* validatePollOptions({
    containerKey: input.containerKey,
    operation: submitOperation,
    pollInterval: input.pollInterval,
    pollTimeout: input.pollTimeout,
    resourceKeys,
  });
  const chunks = yield* chunkResources(input.resources, maxRequestBodyBytes);

  return { ...poll, chunks, submissionConcurrency };
});

interface ValidatedAwaitInput extends ValidatedPollInput {
  readonly candidateOperationIdsByResourceKey: ReadonlyMap<
    string,
    readonly string[]
  >;
  readonly candidateResourceKeysByOperationId: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  readonly operationIds: readonly string[];
}

const validateAwaitInput = Effect.fn(
  "CommercetoolsProductDraftImports.validateAwaitInput"
)(function* (
  input: CommercetoolsProductDraftAwaitInput
): Effect.fn.Return<ValidatedAwaitInput, CommercetoolsImportContractError> {
  if (input.candidates.length === 0) {
    return yield* contractError(
      pollOperation,
      "Awaiting Product Draft imports requires at least one candidate"
    );
  }

  const candidateOperationIdsByResourceKey = new Map<
    string,
    readonly string[]
  >();
  const candidateResourceKeysByOperationId = new Map<string, Set<string>>();
  const operationIds = new Set<string>();
  const resourceKeys = new Set<string>();

  for (const candidateInput of input.candidates) {
    const candidate = normalizeCandidateGroup(candidateInput);

    if (candidate.resourceKey.trim().length === 0) {
      return yield* contractError(
        pollOperation,
        "Product Draft import candidates require non-empty resource keys"
      );
    }
    if (candidate.candidateOperationIds.length === 0) {
      return yield* contractError(
        pollOperation,
        `Product Draft import candidate requires at least one operation id: ${candidate.resourceKey}`
      );
    }
    if (resourceKeys.has(candidate.resourceKey)) {
      return yield* contractError(
        pollOperation,
        `Duplicate Product Draft import candidate resource key: ${candidate.resourceKey}`
      );
    }

    const candidateResourceKeys = new Set(candidate.candidateResourceKeys);

    if (
      candidateResourceKeys.size === 0 ||
      !candidateResourceKeys.has(candidate.resourceKey)
    ) {
      return yield* contractError(
        pollOperation,
        `Product Draft import candidate resource group must contain its requested key: ${candidate.resourceKey}`
      );
    }

    for (const resourceKey of candidateResourceKeys) {
      if (resourceKey.trim().length === 0) {
        return yield* contractError(
          pollOperation,
          "Product Draft import candidate groups require non-empty resource keys",
          { resourceKey: candidate.resourceKey }
        );
      }
    }

    if (candidateResourceKeys.size !== candidate.candidateResourceKeys.length) {
      return yield* contractError(
        pollOperation,
        `Duplicate Product Draft import candidate group key: ${candidate.resourceKey}`
      );
    }

    const candidateOperationIds = new Set<string>();
    for (const operationId of candidate.candidateOperationIds) {
      if (operationId.trim().length === 0) {
        return yield* contractError(
          pollOperation,
          "Product Draft import candidates require non-empty operation ids",
          { resourceKey: candidate.resourceKey }
        );
      }
      if (candidateOperationIds.has(operationId)) {
        return yield* contractError(
          pollOperation,
          `Duplicate Product Draft import candidate operation id: ${operationId}`,
          { resourceKey: candidate.resourceKey }
        );
      }

      candidateOperationIds.add(operationId);
      operationIds.add(operationId);
      const possibleResourceKeys =
        candidateResourceKeysByOperationId.get(operationId) ?? new Set();
      for (const resourceKey of candidateResourceKeys) {
        possibleResourceKeys.add(resourceKey);
      }
      candidateResourceKeysByOperationId.set(operationId, possibleResourceKeys);
    }

    candidateOperationIdsByResourceKey.set(candidate.resourceKey, [
      ...candidateOperationIds,
    ]);
    resourceKeys.add(candidate.resourceKey);
  }

  const poll = yield* validatePollOptions({
    containerKey: input.containerKey,
    operation: pollOperation,
    pollInterval: input.pollInterval,
    pollTimeout: input.pollTimeout,
    resourceKeys,
  });

  return {
    ...poll,
    candidateOperationIdsByResourceKey,
    candidateResourceKeysByOperationId,
    operationIds: [...operationIds],
  };
});

const validateSubmissionResponse = (
  response: ImportResponse,
  expectedCount: number,
  knownOperationIds: Set<string>,
  chunkIndex: number
): Effect.Effect<readonly string[], CommercetoolsImportContractError> =>
  Effect.gen(function* () {
    if (response.operationStatus.length !== expectedCount) {
      return yield* contractError(
        submitOperation,
        "Commercetools Import API returned an unexpected operation count",
        {
          actualCount: response.operationStatus.length,
          chunkIndex,
          expectedCount,
        }
      );
    }

    const operationIds: string[] = [];

    for (const [statusIndex, status] of response.operationStatus.entries()) {
      if (
        status.state !== "processing" &&
        status.state !== "validationFailed"
      ) {
        return yield* contractError(
          submitOperation,
          `Commercetools Import API returned an unknown initial operation state: ${status.state}`,
          { chunkIndex, state: status.state, statusIndex }
        );
      }

      if (
        status.operationId === undefined ||
        status.operationId.trim().length === 0
      ) {
        return yield* contractError(
          submitOperation,
          "Commercetools Import API response cannot be correlated because an operation id is missing",
          { chunkIndex, state: status.state, statusIndex }
        );
      }

      if (knownOperationIds.has(status.operationId)) {
        return yield* contractError(
          submitOperation,
          `Commercetools Import API returned a duplicate operation id: ${status.operationId}`,
          { chunkIndex, operationId: status.operationId, statusIndex }
        );
      }

      knownOperationIds.add(status.operationId);
      operationIds.push(status.operationId);
    }

    return operationIds;
  });

const isPendingState = (
  state: string
): state is CommercetoolsProductDraftImportPendingState =>
  state === "processing" ||
  state === "unresolved" ||
  state === "waitForMasterVariant";

const isFailedState = (
  state: string
): state is CommercetoolsProductDraftImportFailedState =>
  state === "canceled" ||
  state === "partiallyImported" ||
  state === "rejected" ||
  state === "validationFailed";

const validatePolledOperation = (
  requestedOperationId: string,
  operation: ImportOperation,
  input: ValidatedPollInput,
  candidateResourceKeysByOperationId?: ReadonlyMap<string, ReadonlySet<string>>
): Effect.Effect<void, CommercetoolsImportContractError> => {
  if (operation.id !== requestedOperationId) {
    return Effect.fail(
      contractError(
        pollOperation,
        "Commercetools Import Operation id did not match the requested id",
        {
          actualOperationId: operation.id,
          requestedOperationId,
        }
      )
    );
  }

  if (operation.importContainerKey !== input.containerKey) {
    return Effect.fail(
      contractError(
        pollOperation,
        "Commercetools Import Operation belongs to a different Import Container",
        {
          actualContainerKey: operation.importContainerKey,
          expectedContainerKey: input.containerKey,
          operationId: operation.id,
        }
      )
    );
  }

  const candidateResourceKeys =
    candidateResourceKeysByOperationId?.get(requestedOperationId);
  const allowedResourceKeys = candidateResourceKeys ?? input.resourceKeys;

  if (!allowedResourceKeys.has(operation.resourceKey)) {
    return Effect.fail(
      contractError(
        pollOperation,
        "Commercetools Import Operation belongs to an unknown resource key",
        {
          ...(candidateResourceKeys === undefined
            ? {}
            : {
                actualResourceKey: operation.resourceKey,
                candidateResourceKeys: [...candidateResourceKeys],
              }),
          operationId: operation.id,
          ...(candidateResourceKeys === undefined
            ? { resourceKey: operation.resourceKey }
            : {}),
        }
      )
    );
  }

  return Effect.void;
};

const outcomeFromOperation = (
  operation: ImportOperation,
  containerKey: string
): Effect.Effect<
  CommercetoolsProductDraftImportOutcome,
  CommercetoolsImportContractError
> => {
  const base = {
    containerKey,
    operationId: operation.id,
    resourceKey: operation.resourceKey,
  } as const;

  if (operation.state === "imported") {
    return operation.resourceVersion === undefined
      ? Effect.fail(
          contractError(
            pollOperation,
            "Imported Commercetools resource is missing its resource version",
            {
              operationId: operation.id,
              resourceKey: operation.resourceKey,
            }
          )
        )
      : Effect.succeed({
          ...base,
          kind: "imported",
          resourceVersion: operation.resourceVersion,
          state: "imported",
        });
  }

  if (isFailedState(operation.state)) {
    return Effect.succeed({
      ...base,
      errors: operation.errors ?? [],
      kind: "failed",
      ...(operation.resourceVersion === undefined
        ? {}
        : { resourceVersion: operation.resourceVersion }),
      state: operation.state,
    });
  }

  if (isPendingState(operation.state)) {
    return Effect.succeed({
      ...base,
      kind: "pending",
      state: operation.state,
      ...(operation.unresolvedReferences === undefined
        ? {}
        : { unresolvedReferences: operation.unresolvedReferences }),
    });
  }

  return Effect.fail(
    contractError(
      pollOperation,
      `Commercetools Import Operation returned an unknown state: ${operation.state}`,
      {
        operationId: operation.id,
        resourceKey: operation.resourceKey,
        state: operation.state,
      }
    )
  );
};

const outcomesFromKnownOperations = (
  operations: ReadonlyMap<string, ImportOperation>,
  input: ValidatedPollInput
): Effect.Effect<
  Map<string, CommercetoolsProductDraftImportOutcome>,
  CommercetoolsImportContractError
> =>
  Effect.gen(function* () {
    const outcomes = new Map<string, CommercetoolsProductDraftImportOutcome>();

    for (const operation of operations.values()) {
      if (outcomes.has(operation.resourceKey)) {
        return yield* contractError(
          pollOperation,
          `Multiple Commercetools Import Operations resolved to resource key: ${operation.resourceKey}`,
          {
            operationId: operation.id,
            resourceKey: operation.resourceKey,
          }
        );
      }

      outcomes.set(
        operation.resourceKey,
        yield* outcomeFromOperation(operation, input.containerKey)
      );
    }

    return outcomes;
  });

const outcomesForResourceKeys = (
  outcomes: ReadonlyMap<string, CommercetoolsProductDraftImportOutcome>,
  resourceKeys: ReadonlySet<string>
): Map<string, CommercetoolsProductDraftImportOutcome> =>
  new Map(
    [...outcomes].filter(([resourceKey]) => resourceKeys.has(resourceKey))
  );

const candidateResourceKeysForOperationIds = (
  operationIds: readonly string[],
  candidateResourceKeysByOperationId:
    | ReadonlyMap<string, ReadonlySet<string>>
    | undefined,
  fallbackResourceKeys: readonly string[]
): readonly string[] => {
  const candidateResourceKeys = new Set(
    operationIds.flatMap((operationId) => [
      ...(candidateResourceKeysByOperationId?.get(operationId) ?? []),
    ])
  );

  return candidateResourceKeys.size === 0
    ? fallbackResourceKeys
    : [...candidateResourceKeys];
};

interface PollResultSuccess {
  readonly kind: "success";
  readonly operation: ImportOperation;
  readonly operationId: string;
}

interface PollResultFailure {
  readonly error: CommercetoolsImportSdkError;
  readonly kind: "failure";
  readonly operationId: string;
}

type PollResult = PollResultFailure | PollResultSuccess;

const pollingFailureMessage = (
  operationIds: readonly string[],
  errors: ReadonlyMap<string, CommercetoolsImportSdkError>
): string => {
  const failed = operationIds.filter((operationId) => errors.has(operationId));

  return failed.length === 0
    ? "Commercetools Import Operation status could not be correlated before the polling deadline"
    : `Commercetools Import Operation status polling failed for operation ids: ${failed.join(", ")}`;
};

const pollOperations = Effect.fn(
  "CommercetoolsProductDraftImports.pollOperations"
)(function* (
  sdk: CommercetoolsImportSdkService,
  input: ValidatedPollInput,
  operationIds: readonly string[],
  candidateResourceKeysByOperationId?: ReadonlyMap<string, ReadonlySet<string>>,
  candidateOperationIdsByResourceKey?: ReadonlyMap<string, readonly string[]>
): Effect.fn.Return<
  CommercetoolsProductDraftImportOutcomes,
  CommercetoolsImportContractError
> {
  const operations = new Map<string, ImportOperation>();
  const lastPollErrors = new Map<string, CommercetoolsImportSdkError>();
  let pendingOperationIds = [...operationIds];
  const startedAt = yield* Clock.currentTimeMillis;

  while (true) {
    const polled = yield* Effect.forEach(
      pendingOperationIds,
      (operationId): Effect.Effect<PollResult> =>
        sdk
          .request(pollOperation, (project) =>
            project.importOperations().withIdValue({ id: operationId }).get()
          )
          .pipe(
            Effect.map(
              (operation): PollResult => ({
                kind: "success",
                operation,
                operationId,
              })
            ),
            Effect.catch((error) =>
              Effect.succeed({
                error,
                kind: "failure" as const,
                operationId,
              })
            )
          ),
      { concurrency: pollConcurrency }
    );

    for (const result of polled) {
      if (result.kind === "failure") {
        lastPollErrors.set(result.operationId, result.error);
        continue;
      }

      yield* validatePolledOperation(
        result.operationId,
        result.operation,
        input,
        candidateResourceKeysByOperationId
      );
      operations.set(result.operationId, result.operation);
      lastPollErrors.delete(result.operationId);
    }

    const knownOutcomes = yield* outcomesFromKnownOperations(operations, input);
    const outcomes = outcomesForResourceKeys(knownOutcomes, input.resourceKeys);
    pendingOperationIds = operationIds.filter((operationId) => {
      const operation = operations.get(operationId);
      return operation === undefined || isPendingState(operation.state);
    });

    if (pendingOperationIds.length === 0) {
      if (outcomes.size !== input.resourceKeys.size) {
        return yield* contractError(
          pollOperation,
          "Commercetools Import Operations do not cover every submitted resource key",
          {
            missingResourceKeys: [...input.resourceKeys].filter(
              (resourceKey) => !outcomes.has(resourceKey)
            ),
          }
        );
      }

      return outcomes;
    }

    const now = yield* Clock.currentTimeMillis;
    const elapsed = now - startedAt;

    if (elapsed >= input.pollTimeoutMs) {
      const missingResourceKeys = [...input.resourceKeys].filter(
        (resourceKey) => !outcomes.has(resourceKey)
      );
      const missingOperationIds = pendingOperationIds.filter(
        (operationId) => !operations.has(operationId)
      );
      const message = pollingFailureMessage(
        missingOperationIds,
        lastPollErrors
      );

      for (const resourceKey of missingResourceKeys) {
        const exactOperationId = [...missingOperationIds].find(
          (operationId) => {
            const candidateResourceKeys =
              candidateResourceKeysByOperationId?.get(operationId);

            return (
              candidateResourceKeys?.size === 1 &&
              candidateResourceKeys.has(resourceKey)
            );
          }
        );
        const candidateOperationIds =
          exactOperationId === undefined
            ? (candidateOperationIdsByResourceKey
                ?.get(resourceKey)
                ?.filter((operationId) =>
                  missingOperationIds.includes(operationId)
                ) ?? [...missingOperationIds])
            : [exactOperationId];
        outcomes.set(resourceKey, {
          acceptance: "accepted",
          ...makeCandidateGroup({
            candidateOperationIds,
            candidateResourceKeys: candidateResourceKeysForOperationIds(
              candidateOperationIds,
              candidateResourceKeysByOperationId,
              missingResourceKeys
            ),
            resourceKey,
          }),
          containerKey: input.containerKey,
          kind: "indeterminate",
          message,
          state: "pollFailed",
        });
      }

      return outcomes;
    }

    yield* Effect.sleep(
      Math.min(input.pollIntervalMs, input.pollTimeoutMs - elapsed)
    );
  }
});

const submissionFailureOutcomes = (
  input: ValidatedPollInput,
  resources: readonly ProductDraftImport[],
  error: CommercetoolsImportSdkError
): Map<string, CommercetoolsProductDraftImportOutcome> => {
  const outcomes = new Map<string, CommercetoolsProductDraftImportOutcome>();
  const candidateResourceKeys = resources.map((resource) => resource.key);

  for (const resource of resources) {
    outcomes.set(resource.key, {
      acceptance: error.acceptance,
      ...makeCandidateGroup({
        candidateOperationIds: [],
        candidateResourceKeys,
        resourceKey: resource.key,
      }),
      containerKey: input.containerKey,
      kind: "indeterminate",
      message: error.message,
      state: "submissionFailed",
    });
  }

  return outcomes;
};

type ProductDraftChunkSubmission =
  | {
      readonly chunkIndex: number;
      readonly error: CommercetoolsImportSdkError;
      readonly kind: "failure";
      readonly resources: readonly ProductDraftImport[];
    }
  | {
      readonly chunkIndex: number;
      readonly kind: "success";
      readonly resources: readonly ProductDraftImport[];
      readonly response: ImportResponse;
    };

const submitAndAwait = Effect.fn(
  "CommercetoolsProductDraftImports.submitAndAwait"
)(function* (
  rawInput: CommercetoolsProductDraftImportInput
): Effect.fn.Return<
  CommercetoolsProductDraftImportOutcomes,
  CommercetoolsImportSdkError | CommercetoolsImportContractError,
  CommercetoolsImportSdk
> {
  const input = yield* validateImportInput(rawInput);
  const sdk = yield* CommercetoolsImportSdk;
  const knownOperationIds = new Set<string>();
  const operationIds: string[] = [];
  const acceptedResourceKeys = new Set<string>();
  const candidateOperationIdsByResourceKey = new Map<
    string,
    readonly string[]
  >();
  const candidateResourceKeysByOperationId = new Map<
    string,
    ReadonlySet<string>
  >();
  const failedOutcomes = new Map<
    string,
    CommercetoolsProductDraftImportOutcome
  >();
  const submissions = yield* Effect.forEach(
    input.chunks.entries(),
    ([chunkIndex, resources]): Effect.Effect<ProductDraftChunkSubmission> =>
      sdk
        .request(submitOperation, (project) =>
          project
            .productDrafts()
            .importContainers()
            .withImportContainerKeyValue({
              importContainerKey: input.containerKey,
            })
            .post({
              body: {
                resources: [...resources],
                type: "product-draft",
              },
            })
        )
        .pipe(
          Effect.map((response) => ({
            chunkIndex,
            kind: "success" as const,
            resources,
            response,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              chunkIndex,
              error,
              kind: "failure" as const,
              resources,
            })
          )
        ),
    { concurrency: input.submissionConcurrency }
  );

  for (const submission of submissions) {
    const { chunkIndex, resources } = submission;

    if (submission.kind === "failure") {
      for (const [resourceKey, outcome] of submissionFailureOutcomes(
        input,
        resources,
        submission.error
      )) {
        failedOutcomes.set(resourceKey, outcome);
      }
      continue;
    }

    const submittedOperationIds = yield* validateSubmissionResponse(
      submission.response,
      resources.length,
      knownOperationIds,
      chunkIndex
    );
    operationIds.push(...submittedOperationIds);
    const chunkResourceKeys = new Set(
      resources.map((resource) => resource.key)
    );
    for (const operationId of submittedOperationIds) {
      candidateResourceKeysByOperationId.set(operationId, chunkResourceKeys);
    }
    for (const resource of resources) {
      acceptedResourceKeys.add(resource.key);
      candidateOperationIdsByResourceKey.set(
        resource.key,
        submittedOperationIds
      );
    }
  }

  const outcomes =
    operationIds.length === 0
      ? new Map<string, CommercetoolsProductDraftImportOutcome>()
      : new Map(
          yield* pollOperations(
            sdk,
            { ...input, resourceKeys: acceptedResourceKeys },
            operationIds,
            candidateResourceKeysByOperationId,
            candidateOperationIdsByResourceKey
          )
        );

  for (const [resourceKey, outcome] of failedOutcomes) {
    outcomes.set(resourceKey, outcome);
  }

  return outcomes;
});

const awaitOperations = Effect.fn(
  "CommercetoolsProductDraftImports.awaitOperations"
)(function* (
  rawInput: CommercetoolsProductDraftAwaitInput
): Effect.fn.Return<
  CommercetoolsProductDraftImportOutcomes,
  CommercetoolsImportContractError,
  CommercetoolsImportSdk
> {
  const input = yield* validateAwaitInput(rawInput);
  const sdk = yield* CommercetoolsImportSdk;

  return yield* pollOperations(
    sdk,
    input,
    input.operationIds,
    input.candidateResourceKeysByOperationId,
    input.candidateOperationIdsByResourceKey
  );
});

export interface ProvidedCommercetoolsProductDraftImports {
  readonly awaitOperations: (
    input: CommercetoolsProductDraftAwaitInput
  ) => Effect.Effect<
    CommercetoolsProductDraftImportOutcomes,
    CommercetoolsImportContractError
  >;
  readonly changes: typeof productDraftImportChanges;
  readonly recordOperationOutcome: typeof recordOperationOutcome;
  readonly resumeFromJournal: typeof resumeFromJournal;
  readonly submitAndAwait: (
    input: CommercetoolsProductDraftImportInput
  ) => Effect.Effect<
    CommercetoolsProductDraftImportOutcomes,
    CommercetoolsImportSdkError | CommercetoolsImportContractError
  >;
  readonly toOperationError: typeof operationError;
  readonly toProcessBatchContractError: typeof toProcessBatchContractError;
}

const provide = (
  sdkLayer: CommercetoolsImportSdkLayer
): ProvidedCommercetoolsProductDraftImports => ({
  awaitOperations: (input) =>
    awaitOperations(input).pipe(Effect.provide(sdkLayer)),
  changes: productDraftImportChanges,
  recordOperationOutcome,
  resumeFromJournal,
  submitAndAwait: (input) =>
    submitAndAwait(input).pipe(Effect.provide(sdkLayer)),
  toProcessBatchContractError,
  toOperationError: operationError,
});

export const CommercetoolsProductDraftImports = {
  awaitOperations,
  changes: productDraftImportChanges,
  provide,
  recordOperationOutcome,
  resumeFromJournal,
  submitAndAwait,
  toProcessBatchContractError,
  toOperationError: operationError,
} as const;
