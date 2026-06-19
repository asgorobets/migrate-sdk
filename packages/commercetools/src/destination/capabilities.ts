import type {
  ProductSelection,
  ProductSelectionDraft,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  DestinationChangeDescriptor,
  type DestinationChangeDescriptorType,
  DestinationPluginError,
  type EncodedSourceIdentity,
  EncodedSourceIdentity as EncodedSourceIdentitySchema,
  Tracking,
} from "migrate-sdk";
import {
  CommercetoolsSdk,
  type CommercetoolsSdkError,
  type CommercetoolsSdkLayer,
} from "../sdk.ts";

export interface CommercetoolsProductSelectionCreatedChange {
  readonly productSelectionId: string;
  readonly productSelectionKey: string | null;
  readonly productSelectionProductCount: number;
  readonly productSelectionVersion: number;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly [key: string]: Schema.Json;
}

export interface CommercetoolsProductSelectionHelpers<Requirements> {
  readonly changes: {
    readonly created: DestinationChangeDescriptorType<CommercetoolsProductSelectionCreatedChange>;
  };
  readonly create: (
    draft: ProductSelectionDraft
  ) => Effect.Effect<
    ProductSelection,
    DestinationPluginError | Schema.SchemaError,
    Requirements | Tracking
  >;
}

export interface ProvidedCommercetoolsDestination {
  readonly productSelections: CommercetoolsProductSelectionHelpers<never>;
  readonly provide: (
    sdkLayer: CommercetoolsSdkLayer
  ) => ProvidedCommercetoolsDestination;
}

export interface UnprovidedCommercetoolsDestination {
  readonly productSelections: CommercetoolsProductSelectionHelpers<CommercetoolsSdk>;
  readonly provide: (
    sdkLayer: CommercetoolsSdkLayer
  ) => ProvidedCommercetoolsDestination;
}

const productSelectionCreated = DestinationChangeDescriptor.make(
  "commercetools.product-selection.created",
  Schema.Struct({
    productSelectionId: Schema.String,
    productSelectionKey: Schema.NullOr(Schema.String),
    productSelectionProductCount: Schema.Number,
    productSelectionVersion: Schema.Number,
    sourceIdentity: EncodedSourceIdentitySchema,
  })
);

const productSelectionChanges = {
  created: productSelectionCreated,
} as const;

const productSelectionCreatedChange = (
  productSelection: ProductSelection,
  sourceIdentity: EncodedSourceIdentity
): CommercetoolsProductSelectionCreatedChange => ({
  productSelectionId: productSelection.id,
  productSelectionKey: productSelection.key ?? null,
  productSelectionProductCount: productSelection.productCount,
  productSelectionVersion: productSelection.version,
  sourceIdentity,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const statusCodeFromCause = (cause: unknown): number | undefined => {
  if (!isRecord(cause)) {
    return undefined;
  }

  if (typeof cause.statusCode === "number") {
    return cause.statusCode;
  }

  if (isRecord(cause.body) && typeof cause.body.statusCode === "number") {
    return cause.body.statusCode;
  }

  return undefined;
};

const diagnosticField = (
  key: string,
  value: Schema.Json | undefined
): Schema.JsonObject => (value === undefined ? {} : { [key]: value });

const failureDiagnosticDetails = (
  draft: ProductSelectionDraft,
  sourceIdentity: EncodedSourceIdentity,
  cause: CommercetoolsSdkError
): Schema.JsonObject => {
  const statusCode = statusCodeFromCause(cause.cause);

  return {
    operation: cause.operation,
    ...diagnosticField("productSelectionKey", draft.key),
    ...diagnosticField("statusCode", statusCode),
    sourceIdentity,
  };
};

const toDestinationPluginError = (
  cause: CommercetoolsSdkError
): DestinationPluginError =>
  new DestinationPluginError({
    cause,
    message: cause.message,
  });

const createProductSelection = Effect.fn(
  "CommercetoolsDestination.productSelections.create"
)(function* (draft: ProductSelectionDraft) {
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const productSelection = yield* sdk
    .request("productSelections.create", (project) =>
      project.productSelections().post({
        body: draft,
      })
    )
    .pipe(
      Effect.catch((cause) =>
        Tracking.logDiagnostic({
          details: failureDiagnosticDetails(
            draft,
            context.sourceIdentity,
            cause
          ),
          message: "Commercetools product selection create failed",
          severity: "error",
        }).pipe(Effect.andThen(Effect.fail(toDestinationPluginError(cause))))
      )
    );

  yield* Tracking.recordChange(
    productSelectionCreated,
    productSelectionCreatedChange(productSelection, context.sourceIdentity)
  );

  return productSelection;
});

const makeProductSelections = <Requirements>(
  create: CommercetoolsProductSelectionHelpers<Requirements>["create"]
): CommercetoolsProductSelectionHelpers<Requirements> => ({
  changes: productSelectionChanges,
  create,
});

const makeProvided = (
  sdkLayer: CommercetoolsSdkLayer
): ProvidedCommercetoolsDestination => ({
  productSelections: makeProductSelections<never>((draft) =>
    createProductSelection(draft).pipe(Effect.provide(sdkLayer))
  ),
  provide: makeProvided,
});

const make = (): UnprovidedCommercetoolsDestination => ({
  productSelections: makeProductSelections<CommercetoolsSdk>(
    createProductSelection
  ),
  provide: makeProvided,
});

export const CommercetoolsDestination = {
  make,
} as const;
