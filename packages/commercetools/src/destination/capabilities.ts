import type {
  BusinessUnit,
  BusinessUnitDraft,
  BusinessUnitUpdate,
  Customer,
  CustomerDraft,
  CustomerSignInResult,
  CustomerUpdate,
  InventoryEntry,
  InventoryEntryDraft,
  InventoryEntryUpdate,
  Product,
  ProductSelection,
  ProductSelectionDraft,
  ProductSelectionUpdate,
  ProductUpdate,
  Store,
  StoreDraft,
  StoreUpdate,
} from "@commercetools/platform-sdk";
import { Effect, Schema } from "effect";
import {
  DestinationChangeDescriptor,
  type DestinationChangeDescriptorType,
  type DestinationError,
  type EncodedSourceIdentity,
  EncodedSourceIdentity as EncodedSourceIdentitySchema,
  Tracking,
} from "migrate-sdk";
import {
  CommercetoolsSdk,
  type CommercetoolsSdkError,
  type CommercetoolsSdkLayer,
} from "../sdk.ts";
import type { BusinessUnitUpdateAction } from "./business-unit-actions.ts";
import {
  BusinessUnitDraftSchema,
  type CommercetoolsBusinessUnitHelpers as BusinessUnitPureHelpers,
  type BusinessUnitUpdateWithActionsInput,
  BusinessUnitUpdateWithActionsInputSchema,
} from "./business-units.ts";
import {
  type CommercetoolsCustomFieldSchema,
  type CommercetoolsCustomTypeConfig,
  makeBusinessUnitCustomFieldsHelper,
} from "./custom-fields.ts";
import type { CustomerUpdateAction } from "./customer-actions.ts";
import {
  CustomerDraftSchema,
  type CustomerUpdateWithActionsInput,
  CustomerUpdateWithActionsInputSchema,
} from "./customers.ts";
import { toDestinationError } from "./internal/destination-errors.ts";
import {
  InventoryEntryDraftSchema,
  type InventoryEntryUpdateWithActionsInput,
  InventoryEntryUpdateWithActionsInputSchema,
} from "./inventory.ts";
import type { InventoryEntryUpdateAction } from "./inventory-actions.ts";
import type { ProductUpdateAction } from "./product-actions.ts";
import {
  type CommercetoolsProductAttributeSchemasInput,
  makeProductHelpers,
} from "./product-attributes.ts";
import type { ProductSelectionUpdateAction } from "./product-selection-actions.ts";
import {
  ProductSelectionDraftSchema,
  type ProductSelectionUpdateWithActionsInput,
  ProductSelectionUpdateWithActionsInputSchema,
} from "./product-selections.ts";
import {
  type CommercetoolsProductAttributeSchemaRecord,
  type ProductDraftInput,
  ProductDraftSchema,
  type CommercetoolsProductHelpers as ProductPureHelpers,
  type ProductUpdateWithActionsInput,
  ProductUpdateWithActionsInputSchema,
} from "./products.ts";
import type {
  CommercetoolsResourceSelector,
  CommercetoolsStoreSelector,
} from "./selectors.ts";
import type { StoreUpdateAction } from "./store-actions.ts";
import {
  StoreDraftSchema,
  type StoreProductSelectionAssignmentInput,
  StoreProductSelectionAssignmentInputSchema,
  type StoreUpdateWithActionsInput,
  StoreUpdateWithActionsInputSchema,
} from "./stores.ts";

type CommercetoolsDestinationError = DestinationError | Schema.SchemaError;

type ResourceKey = string | null;

export type CommercetoolsResourceType =
  | "business-unit"
  | "customer"
  | "inventory-entry"
  | "product"
  | "product-selection"
  | "store";

export type CommercetoolsChangeSelector =
  | {
      readonly id: string;
      readonly kind: "id";
    }
  | {
      readonly key: string;
      readonly kind: "key";
    };

export interface CommercetoolsResourceChange {
  readonly facts: Schema.JsonObject;
  readonly operation: string;
  readonly resourceId: string;
  readonly resourceKey: ResourceKey;
  readonly resourceType: CommercetoolsResourceType;
  readonly resourceVersion: number;
  readonly selector: CommercetoolsChangeSelector | null;
  readonly sourceIdentity: EncodedSourceIdentity;
  readonly [key: string]: Schema.Json;
}

export interface CommercetoolsResourceHelpers<
  Requirements,
  Resource,
  Draft,
  UpdateInput,
> {
  readonly changes: {
    readonly created: DestinationChangeDescriptorType<CommercetoolsResourceChange>;
    readonly updated: DestinationChangeDescriptorType<CommercetoolsResourceChange>;
  };
  readonly create: (
    draft: Draft
  ) => Effect.Effect<Resource, CommercetoolsDestinationError, Requirements>;
  readonly update: (
    input: UpdateInput
  ) => Effect.Effect<Resource, CommercetoolsDestinationError, Requirements>;
}

export interface CommercetoolsProductHelpers<
  Requirements,
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
> extends ProductPureHelpers<ProductAttributeSchemaRecord>,
    CommercetoolsResourceHelpers<
      Requirements,
      Product,
      ProductDraftInput,
      ProductUpdateWithActionsInput
    > {}

export interface CommercetoolsBusinessUnitHelpers<
  Requirements,
  BusinessUnitCustomFieldSchema extends CommercetoolsCustomFieldSchema | never,
> extends BusinessUnitPureHelpers<BusinessUnitCustomFieldSchema>,
    CommercetoolsResourceHelpers<
      Requirements,
      BusinessUnit,
      BusinessUnitDraft,
      BusinessUnitUpdateWithActionsInput
    > {}

export interface CommercetoolsStoreHelpers<Requirements>
  extends CommercetoolsResourceHelpers<
    Requirements,
    Store,
    StoreDraft,
    StoreUpdateWithActionsInput
  > {
  readonly assignProductSelection: (
    input: StoreProductSelectionAssignmentInput
  ) => Effect.Effect<Store, CommercetoolsDestinationError, Requirements>;
  readonly changes: CommercetoolsResourceHelpers<
    Requirements,
    Store,
    StoreDraft,
    StoreUpdateWithActionsInput
  >["changes"] & {
    readonly productSelectionAssigned: DestinationChangeDescriptorType<CommercetoolsResourceChange>;
    readonly productSelectionRemoved: DestinationChangeDescriptorType<CommercetoolsResourceChange>;
  };
  readonly removeProductSelection: (
    input: StoreProductSelectionAssignmentInput
  ) => Effect.Effect<Store, CommercetoolsDestinationError, Requirements>;
}

export interface CommercetoolsDestinationOptions<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
  BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
> {
  readonly customTypes?: {
    readonly businessUnits: CommercetoolsCustomTypeConfig<BusinessUnitCustomFieldSchema>;
  };
  readonly productTypes?: CommercetoolsProductAttributeSchemasInput<ProductAttributeSchemaRecord>;
}

export interface ProvidedCommercetoolsDestination<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
  BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
> {
  readonly businessUnits: CommercetoolsBusinessUnitHelpers<
    Tracking,
    BusinessUnitCustomFieldSchema
  >;
  readonly customers: CommercetoolsResourceHelpers<
    Tracking,
    Customer,
    CustomerDraft,
    CustomerUpdateWithActionsInput
  >;
  readonly inventory: CommercetoolsResourceHelpers<
    Tracking,
    InventoryEntry,
    InventoryEntryDraft,
    InventoryEntryUpdateWithActionsInput
  >;
  readonly productSelections: CommercetoolsResourceHelpers<
    Tracking,
    ProductSelection,
    ProductSelectionDraft,
    ProductSelectionUpdateWithActionsInput
  >;
  readonly products: CommercetoolsProductHelpers<
    Tracking,
    ProductAttributeSchemaRecord
  >;
  readonly provide: (
    sdkLayer: CommercetoolsSdkLayer
  ) => ProvidedCommercetoolsDestination<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  >;
  readonly stores: CommercetoolsStoreHelpers<Tracking>;
}

export interface UnprovidedCommercetoolsDestination<
  ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
  BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
> {
  readonly businessUnits: CommercetoolsBusinessUnitHelpers<
    CommercetoolsSdk | Tracking,
    BusinessUnitCustomFieldSchema
  >;
  readonly customers: CommercetoolsResourceHelpers<
    CommercetoolsSdk | Tracking,
    Customer,
    CustomerDraft,
    CustomerUpdateWithActionsInput
  >;
  readonly inventory: CommercetoolsResourceHelpers<
    CommercetoolsSdk | Tracking,
    InventoryEntry,
    InventoryEntryDraft,
    InventoryEntryUpdateWithActionsInput
  >;
  readonly productSelections: CommercetoolsResourceHelpers<
    CommercetoolsSdk | Tracking,
    ProductSelection,
    ProductSelectionDraft,
    ProductSelectionUpdateWithActionsInput
  >;
  readonly products: CommercetoolsProductHelpers<
    CommercetoolsSdk | Tracking,
    ProductAttributeSchemaRecord
  >;
  readonly provide: (
    sdkLayer: CommercetoolsSdkLayer
  ) => ProvidedCommercetoolsDestination<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  >;
  readonly stores: CommercetoolsStoreHelpers<CommercetoolsSdk | Tracking>;
}

const ChangeSelectorSchema = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("id"),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal("key"),
  }),
]);

const CommercetoolsResourceChangeSchema = Schema.Struct({
  facts: Schema.Record(Schema.String, Schema.Json),
  operation: Schema.String,
  resourceId: Schema.String,
  resourceKey: Schema.NullOr(Schema.String),
  resourceType: Schema.Literals([
    "business-unit",
    "customer",
    "inventory-entry",
    "product",
    "product-selection",
    "store",
  ]),
  resourceVersion: Schema.Number,
  selector: Schema.NullOr(ChangeSelectorSchema),
  sourceIdentity: EncodedSourceIdentitySchema,
});

const descriptor = (id: string) =>
  DestinationChangeDescriptor.make(id, CommercetoolsResourceChangeSchema);

const businessUnitChanges = {
  created: descriptor("commercetools.business-unit.created"),
  updated: descriptor("commercetools.business-unit.updated"),
} as const;

const customerChanges = {
  created: descriptor("commercetools.customer.created"),
  updated: descriptor("commercetools.customer.updated"),
} as const;

const inventoryChanges = {
  created: descriptor("commercetools.inventory-entry.created"),
  updated: descriptor("commercetools.inventory-entry.updated"),
} as const;

const productChanges = {
  created: descriptor("commercetools.product.created"),
  updated: descriptor("commercetools.product.updated"),
} as const;

const productSelectionChanges = {
  created: descriptor("commercetools.product-selection.created"),
  updated: descriptor("commercetools.product-selection.updated"),
} as const;

const storeChanges = {
  created: descriptor("commercetools.store.created"),
  productSelectionAssigned: descriptor(
    "commercetools.store.product-selection.assigned"
  ),
  productSelectionRemoved: descriptor(
    "commercetools.store.product-selection.removed"
  ),
  updated: descriptor("commercetools.store.updated"),
} as const;

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

const selectorFacts = (
  selector: CommercetoolsResourceSelector | undefined
): Schema.JsonObject => {
  if (selector === undefined) {
    return {};
  }

  return selector.kind === "id"
    ? {
        selectorId: selector.id,
        selectorKind: "id",
      }
    : {
        selectorKey: selector.key,
        selectorKind: "key",
      };
};

const selectorValue = (
  selector: CommercetoolsResourceSelector | undefined
): CommercetoolsChangeSelector | null =>
  selector === undefined ? null : selector;

const requestFailureDetails = (
  input: {
    readonly operation: string;
    readonly resourceType: CommercetoolsResourceType;
    readonly safeFacts?: Schema.JsonObject;
    readonly selector?: CommercetoolsResourceSelector | undefined;
    readonly sourceIdentity: EncodedSourceIdentity;
  },
  cause: CommercetoolsSdkError
): Schema.JsonObject => ({
  operation: cause.operation,
  resourceType: input.resourceType,
  ...selectorFacts(input.selector),
  ...diagnosticField("statusCode", statusCodeFromCause(cause.cause)),
  ...(input.safeFacts ?? {}),
  sourceIdentity: input.sourceIdentity,
});

const runSdkRequest = <A>(input: {
  readonly message: string;
  readonly operation: string;
  readonly request: Effect.Effect<A, CommercetoolsSdkError>;
  readonly resourceType: CommercetoolsResourceType;
  readonly safeFacts?: Schema.JsonObject;
  readonly selector?: CommercetoolsResourceSelector | undefined;
  readonly sourceIdentity: EncodedSourceIdentity;
}): Effect.Effect<A, DestinationError | Schema.SchemaError, Tracking> =>
  input.request.pipe(
    Effect.catch((cause) =>
      Tracking.logDiagnostic({
        details: requestFailureDetails(input, cause),
        message: input.message,
        severity: "error",
      }).pipe(Effect.andThen(Effect.fail(toDestinationError(cause))))
    )
  );

const resourceChange = (input: {
  readonly facts?: Schema.JsonObject;
  readonly operation: string;
  readonly resourceId: string;
  readonly resourceKey: ResourceKey;
  readonly resourceType: CommercetoolsResourceType;
  readonly resourceVersion: number;
  readonly selector?: CommercetoolsResourceSelector | undefined;
  readonly sourceIdentity: EncodedSourceIdentity;
}): CommercetoolsResourceChange => ({
  facts: input.facts ?? {},
  operation: input.operation,
  resourceId: input.resourceId,
  resourceKey: input.resourceKey,
  resourceType: input.resourceType,
  resourceVersion: input.resourceVersion,
  selector: selectorValue(input.selector),
  sourceIdentity: input.sourceIdentity,
});

const recordResourceChange = (
  descriptor: DestinationChangeDescriptorType<CommercetoolsResourceChange>,
  change: CommercetoolsResourceChange
) => Tracking.recordChange(descriptor, change);

const createProduct = Effect.fn("CommercetoolsDestination.products.create")(
  function* (draftInput: ProductDraftInput) {
    const draft = yield* Schema.decodeUnknownEffect(ProductDraftSchema, {
      errors: "all",
    })(draftInput);
    const sdk = yield* CommercetoolsSdk;
    const context = yield* Tracking.currentContext;
    const product = yield* runSdkRequest({
      message: "Commercetools product create failed",
      operation: "products.create",
      request: sdk.request("products.create", (project) =>
        project.products().post({
          body: {
            ...draft,
            publish: false,
          },
        })
      ),
      resourceType: "product",
      safeFacts: {
        productKey: draft.key ?? null,
      },
      sourceIdentity: context.sourceIdentity,
    });

    yield* recordResourceChange(
      productChanges.created,
      resourceChange({
        facts: {
          published: product.masterData.published,
        },
        operation: "products.create",
        resourceId: product.id,
        resourceKey: product.key ?? null,
        resourceType: "product",
        resourceVersion: product.version,
        sourceIdentity: context.sourceIdentity,
      })
    );

    return product;
  }
);

const updateProduct = Effect.fn("CommercetoolsDestination.products.update")(
  function* (input: ProductUpdateWithActionsInput<ProductUpdateAction>) {
    const update = yield* Schema.decodeUnknownEffect(
      ProductUpdateWithActionsInputSchema,
      { errors: "all" }
    )(input);
    const sdk = yield* CommercetoolsSdk;
    const context = yield* Tracking.currentContext;
    const body: ProductUpdate = {
      actions: [...update.actions],
      version: update.version,
    };
    const product = yield* runSdkRequest({
      message: "Commercetools product update failed",
      operation: "products.update",
      request: sdk.request("products.update", (project) => {
        const products = project.products();
        const product =
          update.selector.kind === "id"
            ? products.withId({ ID: update.selector.id })
            : products.withKey({ key: update.selector.key });

        return product.post({ body });
      }),
      resourceType: "product",
      selector: update.selector,
      sourceIdentity: context.sourceIdentity,
    });

    yield* recordResourceChange(
      productChanges.updated,
      resourceChange({
        facts: {
          published: product.masterData.published,
        },
        operation: "products.update",
        resourceId: product.id,
        resourceKey: product.key ?? null,
        resourceType: "product",
        resourceVersion: product.version,
        selector: update.selector,
        sourceIdentity: context.sourceIdentity,
      })
    );

    return product;
  }
);

const createInventoryEntry = Effect.fn(
  "CommercetoolsDestination.inventory.create"
)(function* (draftInput: InventoryEntryDraft) {
  const draft = yield* Schema.decodeUnknownEffect(InventoryEntryDraftSchema, {
    errors: "all",
  })(draftInput);
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const inventoryEntry = yield* runSdkRequest({
    message: "Commercetools inventory entry create failed",
    operation: "inventory.create",
    request: sdk.request("inventory.create", (project) =>
      project.inventory().post({
        body: draft,
      })
    ),
    resourceType: "inventory-entry",
    safeFacts: {
      sku: draft.sku,
    },
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    inventoryChanges.created,
    resourceChange({
      facts: {
        sku: inventoryEntry.sku,
      },
      operation: "inventory.create",
      resourceId: inventoryEntry.id,
      resourceKey: inventoryEntry.key ?? null,
      resourceType: "inventory-entry",
      resourceVersion: inventoryEntry.version,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return inventoryEntry;
});

const updateInventoryEntry = Effect.fn(
  "CommercetoolsDestination.inventory.update"
)(function* (
  input: InventoryEntryUpdateWithActionsInput<InventoryEntryUpdateAction>
) {
  const update = yield* Schema.decodeUnknownEffect(
    InventoryEntryUpdateWithActionsInputSchema,
    { errors: "all" }
  )(input);
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const body: InventoryEntryUpdate = {
    actions: [...update.actions],
    version: update.version,
  };
  const inventoryEntry = yield* runSdkRequest({
    message: "Commercetools inventory entry update failed",
    operation: "inventory.update",
    request: sdk.request("inventory.update", (project) => {
      const inventory = project.inventory();
      const inventoryEntry =
        update.selector.kind === "id"
          ? inventory.withId({ ID: update.selector.id })
          : inventory.withKey({ key: update.selector.key });

      return inventoryEntry.post({ body });
    }),
    resourceType: "inventory-entry",
    selector: update.selector,
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    inventoryChanges.updated,
    resourceChange({
      facts: {
        sku: inventoryEntry.sku,
      },
      operation: "inventory.update",
      resourceId: inventoryEntry.id,
      resourceKey: inventoryEntry.key ?? null,
      resourceType: "inventory-entry",
      resourceVersion: inventoryEntry.version,
      selector: update.selector,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return inventoryEntry;
});

const createCustomer = Effect.fn("CommercetoolsDestination.customers.create")(
  function* (draftInput: CustomerDraft) {
    const draft = yield* Schema.decodeUnknownEffect(CustomerDraftSchema, {
      errors: "all",
    })(draftInput);
    const sdk = yield* CommercetoolsSdk;
    const context = yield* Tracking.currentContext;
    const result = yield* runSdkRequest<CustomerSignInResult>({
      message: "Commercetools customer create failed",
      operation: "customers.create",
      request: sdk.request("customers.create", (project) =>
        project.customers().post({
          body: draft,
        })
      ),
      resourceType: "customer",
      safeFacts: {
        customerKey: draft.key ?? null,
      },
      sourceIdentity: context.sourceIdentity,
    });
    const customer = result.customer;

    yield* recordResourceChange(
      customerChanges.created,
      resourceChange({
        facts: {
          customerKey: customer.key ?? null,
        },
        operation: "customers.create",
        resourceId: customer.id,
        resourceKey: customer.key ?? null,
        resourceType: "customer",
        resourceVersion: customer.version,
        sourceIdentity: context.sourceIdentity,
      })
    );

    return customer;
  }
);

const updateCustomer = Effect.fn("CommercetoolsDestination.customers.update")(
  function* (input: CustomerUpdateWithActionsInput<CustomerUpdateAction>) {
    const update = yield* Schema.decodeUnknownEffect(
      CustomerUpdateWithActionsInputSchema,
      { errors: "all" }
    )(input);
    const sdk = yield* CommercetoolsSdk;
    const context = yield* Tracking.currentContext;
    const body: CustomerUpdate = {
      actions: [...update.actions],
      version: update.version,
    };
    const customer = yield* runSdkRequest({
      message: "Commercetools customer update failed",
      operation: "customers.update",
      request: sdk.request("customers.update", (project) => {
        const customers = project.customers();
        const customer =
          update.selector.kind === "id"
            ? customers.withId({ ID: update.selector.id })
            : customers.withKey({ key: update.selector.key });

        return customer.post({ body });
      }),
      resourceType: "customer",
      selector: update.selector,
      sourceIdentity: context.sourceIdentity,
    });

    yield* recordResourceChange(
      customerChanges.updated,
      resourceChange({
        facts: {
          customerKey: customer.key ?? null,
        },
        operation: "customers.update",
        resourceId: customer.id,
        resourceKey: customer.key ?? null,
        resourceType: "customer",
        resourceVersion: customer.version,
        selector: update.selector,
        sourceIdentity: context.sourceIdentity,
      })
    );

    return customer;
  }
);

const createBusinessUnit = Effect.fn(
  "CommercetoolsDestination.businessUnits.create"
)(function* (draftInput: BusinessUnitDraft) {
  const draft = yield* Schema.decodeUnknownEffect(BusinessUnitDraftSchema, {
    errors: "all",
  })(draftInput);
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const businessUnit = yield* runSdkRequest({
    message: "Commercetools business unit create failed",
    operation: "businessUnits.create",
    request: sdk.request("businessUnits.create", (project) =>
      project.businessUnits().post({
        body: draft,
      })
    ),
    resourceType: "business-unit",
    safeFacts: {
      businessUnitKey: draft.key,
      unitType: draft.unitType,
    },
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    businessUnitChanges.created,
    resourceChange({
      facts: {
        unitType: businessUnit.unitType,
      },
      operation: "businessUnits.create",
      resourceId: businessUnit.id,
      resourceKey: businessUnit.key,
      resourceType: "business-unit",
      resourceVersion: businessUnit.version,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return businessUnit;
});

const updateBusinessUnit = Effect.fn(
  "CommercetoolsDestination.businessUnits.update"
)(function* (
  input: BusinessUnitUpdateWithActionsInput<BusinessUnitUpdateAction>
) {
  const update = yield* Schema.decodeUnknownEffect(
    BusinessUnitUpdateWithActionsInputSchema,
    { errors: "all" }
  )(input);
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const body: BusinessUnitUpdate = {
    actions: [...update.actions],
    version: update.version,
  };
  const businessUnit = yield* runSdkRequest({
    message: "Commercetools business unit update failed",
    operation: "businessUnits.update",
    request: sdk.request("businessUnits.update", (project) => {
      const businessUnits = project.businessUnits();
      const businessUnit =
        update.selector.kind === "id"
          ? businessUnits.withId({ ID: update.selector.id })
          : businessUnits.withKey({ key: update.selector.key });

      return businessUnit.post({ body });
    }),
    resourceType: "business-unit",
    selector: update.selector,
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    businessUnitChanges.updated,
    resourceChange({
      facts: {
        unitType: businessUnit.unitType,
      },
      operation: "businessUnits.update",
      resourceId: businessUnit.id,
      resourceKey: businessUnit.key,
      resourceType: "business-unit",
      resourceVersion: businessUnit.version,
      selector: update.selector,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return businessUnit;
});

const createStore = Effect.fn("CommercetoolsDestination.stores.create")(
  function* (draftInput: StoreDraft) {
    const draft = yield* Schema.decodeUnknownEffect(StoreDraftSchema, {
      errors: "all",
    })(draftInput);
    const sdk = yield* CommercetoolsSdk;
    const context = yield* Tracking.currentContext;
    const store = yield* runSdkRequest({
      message: "Commercetools store create failed",
      operation: "stores.create",
      request: sdk.request("stores.create", (project) =>
        project.stores().post({
          body: draft,
        })
      ),
      resourceType: "store",
      safeFacts: {
        storeKey: draft.key,
      },
      sourceIdentity: context.sourceIdentity,
    });

    yield* recordResourceChange(
      storeChanges.created,
      resourceChange({
        facts: {
          productSelectionCount: store.productSelections.length,
        },
        operation: "stores.create",
        resourceId: store.id,
        resourceKey: store.key,
        resourceType: "store",
        resourceVersion: store.version,
        sourceIdentity: context.sourceIdentity,
      })
    );

    return store;
  }
);

const updateStoreWithActions = Effect.fn(
  "CommercetoolsDestination.stores.updateWithActions"
)(function* (input: {
  readonly actions: readonly [StoreUpdateAction, ...StoreUpdateAction[]];
  readonly descriptor: DestinationChangeDescriptorType<CommercetoolsResourceChange>;
  readonly facts?: Schema.JsonObject;
  readonly operation: string;
  readonly selector: CommercetoolsStoreSelector;
  readonly version: number;
}) {
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const body: StoreUpdate = {
    actions: [...input.actions],
    version: input.version,
  };
  const store = yield* runSdkRequest({
    message: `Commercetools store ${input.operation} failed`,
    operation: input.operation,
    request: sdk.request(input.operation, (project) => {
      const stores = project.stores();
      const store =
        input.selector.kind === "id"
          ? stores.withId({ ID: input.selector.id })
          : stores.withKey({ key: input.selector.key });

      return store.post({ body });
    }),
    resourceType: "store",
    selector: input.selector,
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    input.descriptor,
    resourceChange({
      facts: {
        productSelectionCount: store.productSelections.length,
        ...(input.facts ?? {}),
      },
      operation: input.operation,
      resourceId: store.id,
      resourceKey: store.key,
      resourceType: "store",
      resourceVersion: store.version,
      selector: input.selector,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return store;
});

const updateStore = Effect.fn("CommercetoolsDestination.stores.update")(
  function* (input: StoreUpdateWithActionsInput<StoreUpdateAction>) {
    const update = yield* Schema.decodeUnknownEffect(
      StoreUpdateWithActionsInputSchema,
      { errors: "all" }
    )(input);

    return yield* updateStoreWithActions({
      actions: update.actions,
      descriptor: storeChanges.updated,
      operation: "stores.update",
      selector: update.selector,
      version: update.version,
    });
  }
);

const productSelectionAssignmentFacts = (
  input: StoreProductSelectionAssignmentInput
): Schema.JsonObject =>
  "id" in input.productSelection
    ? {
        productSelectionId: input.productSelection.id,
      }
    : {
        productSelectionKey: input.productSelection.key,
      };

const assignProductSelectionToStore = Effect.fn(
  "CommercetoolsDestination.stores.assignProductSelection"
)(function* (input: StoreProductSelectionAssignmentInput) {
  const assignment = yield* Schema.decodeUnknownEffect(
    StoreProductSelectionAssignmentInputSchema,
    { errors: "all" }
  )(input);

  return yield* updateStoreWithActions({
    actions: [
      {
        action: "addProductSelection",
        productSelection: assignment.productSelection,
      },
    ],
    descriptor: storeChanges.productSelectionAssigned,
    facts: productSelectionAssignmentFacts(assignment),
    operation: "stores.assignProductSelection",
    selector: assignment.selector,
    version: assignment.version,
  });
});

const removeProductSelectionFromStore = Effect.fn(
  "CommercetoolsDestination.stores.removeProductSelection"
)(function* (input: StoreProductSelectionAssignmentInput) {
  const assignment = yield* Schema.decodeUnknownEffect(
    StoreProductSelectionAssignmentInputSchema,
    { errors: "all" }
  )(input);

  return yield* updateStoreWithActions({
    actions: [
      {
        action: "removeProductSelection",
        productSelection: assignment.productSelection,
      },
    ],
    descriptor: storeChanges.productSelectionRemoved,
    facts: productSelectionAssignmentFacts(assignment),
    operation: "stores.removeProductSelection",
    selector: assignment.selector,
    version: assignment.version,
  });
});

const createProductSelection = Effect.fn(
  "CommercetoolsDestination.productSelections.create"
)(function* (draftInput: ProductSelectionDraft) {
  const draft = yield* Schema.decodeUnknownEffect(ProductSelectionDraftSchema, {
    errors: "all",
  })(draftInput);
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const productSelection = yield* runSdkRequest({
    message: "Commercetools product selection create failed",
    operation: "productSelections.create",
    request: sdk.request("productSelections.create", (project) =>
      project.productSelections().post({
        body: draft,
      })
    ),
    resourceType: "product-selection",
    safeFacts: {
      productSelectionKey: draft.key ?? null,
    },
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    productSelectionChanges.created,
    resourceChange({
      facts: {
        productCount: productSelection.productCount,
      },
      operation: "productSelections.create",
      resourceId: productSelection.id,
      resourceKey: productSelection.key ?? null,
      resourceType: "product-selection",
      resourceVersion: productSelection.version,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return productSelection;
});

const updateProductSelection = Effect.fn(
  "CommercetoolsDestination.productSelections.update"
)(function* (
  input: ProductSelectionUpdateWithActionsInput<ProductSelectionUpdateAction>
) {
  const update = yield* Schema.decodeUnknownEffect(
    ProductSelectionUpdateWithActionsInputSchema,
    { errors: "all" }
  )(input);
  const sdk = yield* CommercetoolsSdk;
  const context = yield* Tracking.currentContext;
  const body: ProductSelectionUpdate = {
    actions: [...update.actions],
    version: update.version,
  };
  const productSelection = yield* runSdkRequest({
    message: "Commercetools product selection update failed",
    operation: "productSelections.update",
    request: sdk.request("productSelections.update", (project) => {
      const productSelections = project.productSelections();
      const productSelection =
        update.selector.kind === "id"
          ? productSelections.withId({ ID: update.selector.id })
          : productSelections.withKey({ key: update.selector.key });

      return productSelection.post({ body });
    }),
    resourceType: "product-selection",
    selector: update.selector,
    sourceIdentity: context.sourceIdentity,
  });

  yield* recordResourceChange(
    productSelectionChanges.updated,
    resourceChange({
      facts: {
        productCount: productSelection.productCount,
      },
      operation: "productSelections.update",
      resourceId: productSelection.id,
      resourceKey: productSelection.key ?? null,
      resourceType: "product-selection",
      resourceVersion: productSelection.version,
      selector: update.selector,
      sourceIdentity: context.sourceIdentity,
    })
  );

  return productSelection;
});

const makeUnprovided = <
  const ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
  const BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
>(
  options: CommercetoolsDestinationOptions<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  >
): UnprovidedCommercetoolsDestination<
  ProductAttributeSchemaRecord,
  BusinessUnitCustomFieldSchema
> => ({
  businessUnits: {
    customFields: makeBusinessUnitCustomFieldsHelper(
      options.customTypes?.businessUnits
    ),
    changes: businessUnitChanges,
    create: createBusinessUnit,
    update: updateBusinessUnit,
  },
  customers: {
    changes: customerChanges,
    create: createCustomer,
    update: updateCustomer,
  },
  inventory: {
    changes: inventoryChanges,
    create: createInventoryEntry,
    update: updateInventoryEntry,
  },
  productSelections: {
    changes: productSelectionChanges,
    create: createProductSelection,
    update: updateProductSelection,
  },
  products: {
    ...makeProductHelpers(options.productTypes),
    changes: productChanges,
    create: createProduct,
    update: updateProduct,
  },
  provide: (sdkLayer) => makeProvided(options, sdkLayer),
  stores: {
    assignProductSelection: assignProductSelectionToStore,
    changes: storeChanges,
    create: createStore,
    removeProductSelection: removeProductSelectionFromStore,
    update: updateStore,
  },
});

const makeProvided = <
  const ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord,
  const BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
>(
  options: CommercetoolsDestinationOptions<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  >,
  sdkLayer: CommercetoolsSdkLayer
): ProvidedCommercetoolsDestination<
  ProductAttributeSchemaRecord,
  BusinessUnitCustomFieldSchema
> => ({
  businessUnits: {
    customFields: makeBusinessUnitCustomFieldsHelper(
      options.customTypes?.businessUnits
    ),
    changes: businessUnitChanges,
    create: (draft) => createBusinessUnit(draft).pipe(Effect.provide(sdkLayer)),
    update: (input) => updateBusinessUnit(input).pipe(Effect.provide(sdkLayer)),
  },
  customers: {
    changes: customerChanges,
    create: (draft) => createCustomer(draft).pipe(Effect.provide(sdkLayer)),
    update: (input) => updateCustomer(input).pipe(Effect.provide(sdkLayer)),
  },
  inventory: {
    changes: inventoryChanges,
    create: (draft) =>
      createInventoryEntry(draft).pipe(Effect.provide(sdkLayer)),
    update: (input) =>
      updateInventoryEntry(input).pipe(Effect.provide(sdkLayer)),
  },
  productSelections: {
    changes: productSelectionChanges,
    create: (draft) =>
      createProductSelection(draft).pipe(Effect.provide(sdkLayer)),
    update: (input) =>
      updateProductSelection(input).pipe(Effect.provide(sdkLayer)),
  },
  products: {
    ...makeProductHelpers(options.productTypes),
    changes: productChanges,
    create: (draft) => createProduct(draft).pipe(Effect.provide(sdkLayer)),
    update: (input) => updateProduct(input).pipe(Effect.provide(sdkLayer)),
  },
  provide: (nextSdkLayer) => makeProvided(options, nextSdkLayer),
  stores: {
    assignProductSelection: (input) =>
      assignProductSelectionToStore(input).pipe(Effect.provide(sdkLayer)),
    changes: storeChanges,
    create: (draft) => createStore(draft).pipe(Effect.provide(sdkLayer)),
    removeProductSelection: (input) =>
      removeProductSelectionFromStore(input).pipe(Effect.provide(sdkLayer)),
    update: (input) => updateStore(input).pipe(Effect.provide(sdkLayer)),
  },
});

const make = <
  const ProductAttributeSchemaRecord extends
    CommercetoolsProductAttributeSchemaRecord = Record<never, never>,
  const BusinessUnitCustomFieldSchema extends
    | CommercetoolsCustomFieldSchema
    | never = never,
>(
  options: CommercetoolsDestinationOptions<
    ProductAttributeSchemaRecord,
    BusinessUnitCustomFieldSchema
  > = {}
): UnprovidedCommercetoolsDestination<
  ProductAttributeSchemaRecord,
  BusinessUnitCustomFieldSchema
> => makeUnprovided(options);

export const CommercetoolsDestination = {
  make,
} as const;
