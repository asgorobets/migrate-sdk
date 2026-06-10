import type {
  ApiRoot,
  BusinessUnit,
  BusinessUnitDraft,
  BusinessUnitUpdate,
  BusinessUnitUpdateAction,
  ClientRequest,
  Customer,
  CustomerDraft,
  CustomerSignInResult,
  CustomerUpdate,
  CustomerUpdateAction,
  CustomObject,
  CustomObjectDraft,
  InventoryEntry,
  InventoryEntryDraft,
  InventoryEntryUpdate,
  InventoryEntryUpdateAction,
  Product,
  ProductData,
  ProductDraft,
  ProductSelection,
  ProductSelectionDraft,
  ProductSelectionUpdate,
  ProductSelectionUpdateAction,
  ProductUpdate,
  ProductUpdateAction,
  ProductVariant,
  Store,
  StoreDraft,
  StoreUpdate,
  StoreUpdateAction,
} from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";

export type RecordedCommercetoolsRequestBody =
  | BusinessUnitDraft
  | CustomObjectDraft
  | BusinessUnitUpdate
  | CustomerDraft
  | CustomerUpdate
  | InventoryEntryDraft
  | InventoryEntryUpdate
  | ProductDraft
  | ProductSelectionDraft
  | ProductSelectionUpdate
  | ProductUpdate
  | StoreDraft
  | StoreUpdate;

export interface RecordedCommercetoolsRequest {
  readonly body?: RecordedCommercetoolsRequestBody;
  readonly method: ClientRequest["method"];
  readonly pathVariables?: ClientRequest["pathVariables"];
  readonly queryParams?: ClientRequest["queryParams"];
  readonly uri?: string;
  readonly uriTemplate?: string;
}

export interface RecordingCommercetoolsApiRoot {
  readonly apiRoot: ApiRoot;
  readonly requests: readonly RecordedCommercetoolsRequest[];
}

type RecordedCommercetoolsResponseBody =
  | BusinessUnit
  | CustomObject
  | Customer
  | CustomerSignInResult
  | InventoryEntry
  | Product
  | ProductSelection
  | Store;

interface RecordedCommercetoolsResponse {
  readonly body: RecordedCommercetoolsResponseBody;
}

const recordedResponse = (
  body: RecordedCommercetoolsResponseBody
): Promise<RecordedCommercetoolsResponse> =>
  Promise.resolve({
    body,
  });

const isRecord = (value: ClientRequest["body"]): value is object =>
  typeof value === "object" && value !== null;

const isProductUpdate = (
  value: ClientRequest["body"]
): value is ProductUpdate =>
  isRecord(value) && "actions" in value && Array.isArray(value.actions);

const isBusinessUnitUpdate = (
  value: ClientRequest["body"]
): value is BusinessUnitUpdate =>
  isRecord(value) && "actions" in value && Array.isArray(value.actions);

const isCustomerUpdate = (
  value: ClientRequest["body"]
): value is CustomerUpdate =>
  isRecord(value) && "actions" in value && Array.isArray(value.actions);

const isCustomObjectDraft = (
  value: ClientRequest["body"]
): value is CustomObjectDraft =>
  isRecord(value) && "container" in value && "key" in value && "value" in value;

const isInventoryEntryUpdate = (
  value: ClientRequest["body"]
): value is InventoryEntryUpdate =>
  isRecord(value) && "actions" in value && Array.isArray(value.actions);

const isProductSelectionUpdate = (
  value: ClientRequest["body"]
): value is ProductSelectionUpdate =>
  isRecord(value) && "actions" in value && Array.isArray(value.actions);

const isStoreUpdate = (value: ClientRequest["body"]): value is StoreUpdate =>
  isRecord(value) && "actions" in value && Array.isArray(value.actions);

const isProductDraft = (value: ClientRequest["body"]): value is ProductDraft =>
  isRecord(value) &&
  "productType" in value &&
  "name" in value &&
  "slug" in value;

const isInventoryEntryDraft = (
  value: ClientRequest["body"]
): value is InventoryEntryDraft =>
  isRecord(value) && "sku" in value && "quantityOnStock" in value;

const isProductSelectionDraft = (
  value: ClientRequest["body"]
): value is ProductSelectionDraft =>
  isRecord(value) && "name" in value && !("productType" in value);

const isStoreDraft = (value: ClientRequest["body"]): value is StoreDraft =>
  isRecord(value) && "key" in value;

const isBusinessUnitDraft = (
  value: ClientRequest["body"]
): value is BusinessUnitDraft =>
  isRecord(value) && "key" in value && "name" in value && "unitType" in value;

const isCustomerDraft = (
  value: ClientRequest["body"]
): value is CustomerDraft => isRecord(value) && "email" in value;

const requestBody = (
  request: ClientRequest
): RecordedCommercetoolsRequestBody | undefined => {
  if (
    isProductDraft(request.body) ||
    isProductUpdate(request.body) ||
    isBusinessUnitDraft(request.body) ||
    isBusinessUnitUpdate(request.body) ||
    isCustomObjectDraft(request.body) ||
    isCustomerDraft(request.body) ||
    isCustomerUpdate(request.body) ||
    isInventoryEntryDraft(request.body) ||
    isInventoryEntryUpdate(request.body) ||
    isProductSelectionDraft(request.body) ||
    isProductSelectionUpdate(request.body) ||
    isStoreDraft(request.body) ||
    isStoreUpdate(request.body)
  ) {
    return request.body;
  }

  return undefined;
};

const recordRequest = (
  request: ClientRequest
): RecordedCommercetoolsRequest => {
  const body = requestBody(request);

  return {
    ...(body === undefined ? {} : { body }),
    method: request.method,
    ...(request.pathVariables === undefined
      ? {}
      : { pathVariables: request.pathVariables }),
    ...(request.queryParams === undefined
      ? {}
      : { queryParams: request.queryParams }),
    ...(request.uri === undefined ? {} : { uri: request.uri }),
    ...(request.uriTemplate === undefined
      ? {}
      : { uriTemplate: request.uriTemplate }),
  };
};

const productVariant = (draft: ProductDraft): ProductVariant => ({
  id: 1,
  ...(draft.masterVariant?.attributes === undefined
    ? {}
    : { attributes: draft.masterVariant.attributes }),
  ...(draft.masterVariant?.key === undefined
    ? {}
    : { key: draft.masterVariant.key }),
  ...(draft.masterVariant?.sku === undefined
    ? {}
    : { sku: draft.masterVariant.sku }),
});

const productData = (draft: ProductDraft): ProductData => {
  const masterVariant = productVariant(draft);

  return {
    attributes: masterVariant.attributes ?? [],
    categories: [],
    ...(draft.categoryOrderHints === undefined
      ? {}
      : { categoryOrderHints: draft.categoryOrderHints }),
    ...(draft.description === undefined
      ? {}
      : { description: draft.description }),
    masterVariant,
    name: draft.name,
    searchKeywords: {},
    slug: draft.slug,
    variants: [],
  };
};

const recordedProduct = ({
  draft,
  id,
  published,
  version,
}: {
  readonly draft: ProductDraft;
  readonly id: string;
  readonly published: boolean;
  readonly version: number;
}): Product => {
  const data = productData(draft);
  const productType: Product["productType"] = {
    id:
      draft.productType.id ?? draft.productType.key ?? "recording-product-type",
    typeId: "product-type",
  };

  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    ...(draft.key === undefined ? {} : { key: draft.key }),
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    masterData: {
      current: data,
      hasStagedChanges: !published,
      published,
      staged: data,
    },
    productType,
    version,
  };
};

const applyRecordedProductAction = (
  draft: ProductDraft,
  action: ProductUpdateAction
): ProductDraft => {
  switch (action.action) {
    case "changeName":
      return {
        ...draft,
        name: action.name,
      };
    case "changeSlug":
      return {
        ...draft,
        slug: action.slug,
      };
    case "setDescription":
      return action.description === undefined
        ? draft
        : {
            ...draft,
            description: action.description,
          };
    default:
      return draft;
  }
};

const recordedBusinessUnit = ({
  draft,
  id,
  version,
}: {
  readonly draft: BusinessUnitDraft;
  readonly id: string;
  readonly version: number;
}): BusinessUnit => {
  const topLevelUnit: BusinessUnit["topLevelUnit"] = {
    key:
      draft.unitType === "Company"
        ? draft.key
        : (draft.parentUnit.key ?? "recording-top-level-business-unit"),
    typeId: "business-unit",
  };
  const shared = {
    addresses: [],
    approvalRuleMode:
      draft.approvalRuleMode ??
      (draft.unitType === "Company" ? "Explicit" : "ExplicitAndFromParent"),
    associateMode:
      draft.associateMode ??
      (draft.unitType === "Company" ? "Explicit" : "ExplicitAndFromParent"),
    associates: [],
    billingAddressIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    key: draft.key,
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    name: draft.name,
    shippingAddressIds: [],
    status: draft.status ?? "Active",
    storeMode:
      draft.storeMode ??
      (draft.unitType === "Company" ? "Explicit" : "FromParent"),
    topLevelUnit,
    version,
  } satisfies Omit<BusinessUnit, "unitType">;

  if (draft.unitType === "Company") {
    return {
      ...shared,
      unitType: "Company",
    };
  }

  return {
    ...shared,
    parentUnit: {
      key: draft.parentUnit.key ?? "recording-parent-business-unit",
      typeId: "business-unit",
    },
    unitType: "Division",
  };
};

const applyRecordedBusinessUnitAction = (
  draft: BusinessUnitDraft,
  action: BusinessUnitUpdateAction
): BusinessUnitDraft => {
  switch (action.action) {
    case "changeName":
      return {
        ...draft,
        name: action.name,
      };
    case "setCustomField": {
      const custom = draft.custom;

      if (custom === undefined) {
        return draft;
      }

      const fields = {
        ...custom.fields,
      };

      if (action.value === undefined) {
        delete fields[action.name];
      } else {
        fields[action.name] = action.value;
      }

      return {
        ...draft,
        custom: {
          ...custom,
          fields,
        },
      };
    }
    default:
      return draft;
  }
};

const isBusinessUnitRequest = (request: ClientRequest): boolean =>
  request.uriTemplate?.includes("business-units") === true;

const isCustomObjectRequest = (request: ClientRequest): boolean =>
  request.uriTemplate?.includes("custom-objects") === true;

const customObjectStorageKey = (container: string, key: string): string =>
  `${container}\u0000${key}`;

const customObjectPath = (
  request: ClientRequest
): { readonly container: string; readonly key: string } | undefined => {
  const container = request.pathVariables?.container;
  const key = request.pathVariables?.key;

  if (typeof container !== "string" || typeof key !== "string") {
    return undefined;
  }

  return { container, key };
};

const customObjectVersion = (request: ClientRequest): number | undefined => {
  const version = request.queryParams?.version;

  if (typeof version === "number") {
    return version;
  }

  if (typeof version === "string") {
    return Number.parseInt(version, 10);
  }

  return undefined;
};

const recordedCustomObject = ({
  draft,
  id,
  version,
}: {
  readonly draft: CustomObjectDraft;
  readonly id: string;
  readonly version: number;
}): CustomObject => ({
  container: draft.container,
  createdAt: "2026-01-01T00:00:00.000Z",
  id,
  key: draft.key,
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  value: draft.value,
  version,
});

const recordedNotFoundError = (message: string): Error & { statusCode: 404 } =>
  Object.assign(new Error(message), {
    body: {
      message,
      statusCode: 404,
    },
    code: 404,
    statusCode: 404,
  } as const);

const recordedConflictError = (message: string): Error & { statusCode: 409 } =>
  Object.assign(new Error(message), {
    body: {
      message,
      statusCode: 409,
    },
    code: 409,
    statusCode: 409,
  } as const);

const recordedCustomer = ({
  draft,
  id,
  version,
}: {
  readonly draft: CustomerDraft;
  readonly id: string;
  readonly version: number;
}): Customer => ({
  addresses: [],
  authenticationMode: draft.authenticationMode ?? "Password",
  billingAddressIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  customerGroupAssignments: [],
  ...(draft.companyName === undefined
    ? {}
    : { companyName: draft.companyName }),
  ...(draft.customerNumber === undefined
    ? {}
    : { customerNumber: draft.customerNumber }),
  ...(draft.dateOfBirth === undefined
    ? {}
    : { dateOfBirth: draft.dateOfBirth }),
  email: draft.email,
  ...(draft.externalId === undefined ? {} : { externalId: draft.externalId }),
  ...(draft.firstName === undefined ? {} : { firstName: draft.firstName }),
  id,
  isEmailVerified: draft.isEmailVerified ?? false,
  ...(draft.key === undefined ? {} : { key: draft.key }),
  ...(draft.lastName === undefined ? {} : { lastName: draft.lastName }),
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  ...(draft.locale === undefined ? {} : { locale: draft.locale }),
  ...(draft.middleName === undefined ? {} : { middleName: draft.middleName }),
  ...(draft.password === undefined ? {} : { password: draft.password }),
  ...(draft.salutation === undefined ? {} : { salutation: draft.salutation }),
  shippingAddressIds: [],
  stores: [],
  ...(draft.title === undefined ? {} : { title: draft.title }),
  ...(draft.vatId === undefined ? {} : { vatId: draft.vatId }),
  version,
});

const recordedCustomerSignInResult = ({
  draft,
  id,
  version,
}: {
  readonly draft: CustomerDraft;
  readonly id: string;
  readonly version: number;
}): CustomerSignInResult => ({
  customer: recordedCustomer({
    draft,
    id,
    version,
  }),
});

const setOptionalCustomerField = <
  const Field extends keyof CustomerDraft,
  const Value extends CustomerDraft[Field],
>(
  draft: CustomerDraft,
  field: Field,
  value: Value | undefined
): CustomerDraft => {
  if (value === undefined) {
    const nextDraft = {
      ...draft,
    };

    delete nextDraft[field];

    return nextDraft;
  }

  return {
    ...draft,
    [field]: value,
  };
};

const applyRecordedCustomerAction = (
  draft: CustomerDraft,
  action: CustomerUpdateAction
): CustomerDraft => {
  switch (action.action) {
    case "changeEmail":
      return {
        ...draft,
        email: action.email,
      };
    case "setCompanyName":
      return setOptionalCustomerField(draft, "companyName", action.companyName);
    case "setFirstName":
      return setOptionalCustomerField(draft, "firstName", action.firstName);
    case "setKey":
      return setOptionalCustomerField(draft, "key", action.key);
    case "setLastName":
      return setOptionalCustomerField(draft, "lastName", action.lastName);
    default:
      return draft;
  }
};

const isCustomerRequest = (request: ClientRequest): boolean =>
  request.uriTemplate?.includes("customers") === true;

const recordedInventoryEntry = ({
  draft,
  id,
  version,
}: {
  readonly draft: InventoryEntryDraft;
  readonly id: string;
  readonly version: number;
}): InventoryEntry => ({
  availableQuantity: draft.quantityOnStock,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(draft.expectedDelivery === undefined
    ? {}
    : { expectedDelivery: draft.expectedDelivery }),
  id,
  ...(draft.key === undefined ? {} : { key: draft.key }),
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  ...(draft.maxCartQuantity === undefined
    ? {}
    : { maxCartQuantity: draft.maxCartQuantity }),
  ...(draft.minCartQuantity === undefined
    ? {}
    : { minCartQuantity: draft.minCartQuantity }),
  quantityOnStock: draft.quantityOnStock,
  ...(draft.restockableInDays === undefined
    ? {}
    : { restockableInDays: draft.restockableInDays }),
  sku: draft.sku,
  version,
});

const setOptionalInventoryEntryField = <
  const Field extends keyof InventoryEntryDraft,
  const Value extends InventoryEntryDraft[Field],
>(
  draft: InventoryEntryDraft,
  field: Field,
  value: Value | undefined
): InventoryEntryDraft => {
  if (value === undefined) {
    const nextDraft = {
      ...draft,
    };

    delete nextDraft[field];

    return nextDraft;
  }

  return {
    ...draft,
    [field]: value,
  };
};

const applyRecordedInventoryEntryAction = (
  draft: InventoryEntryDraft,
  action: InventoryEntryUpdateAction
): InventoryEntryDraft => {
  switch (action.action) {
    case "addQuantity":
      return {
        ...draft,
        quantityOnStock: draft.quantityOnStock + action.quantity,
      };
    case "changeQuantity":
      return {
        ...draft,
        quantityOnStock: action.quantity,
      };
    case "removeQuantity":
      return {
        ...draft,
        quantityOnStock: draft.quantityOnStock - action.quantity,
      };
    case "setExpectedDelivery":
      return setOptionalInventoryEntryField(
        draft,
        "expectedDelivery",
        action.expectedDelivery
      );
    case "setKey":
      return setOptionalInventoryEntryField(draft, "key", action.key);
    case "setRestockableInDays":
      return setOptionalInventoryEntryField(
        draft,
        "restockableInDays",
        action.restockableInDays
      );
    default:
      return draft;
  }
};

const isInventoryRequest = (request: ClientRequest): boolean =>
  request.uriTemplate?.includes("inventory") === true;

const recordedProductSelection = ({
  draft,
  id,
  productCount,
  version,
}: {
  readonly draft: ProductSelectionDraft;
  readonly id: string;
  readonly productCount: number;
  readonly version: number;
}): ProductSelection => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  id,
  ...(draft.key === undefined ? {} : { key: draft.key }),
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  mode: draft.mode ?? "Individual",
  name: draft.name,
  productCount,
  version,
});

const setOptionalProductSelectionField = <
  const Field extends keyof ProductSelectionDraft,
  const Value extends ProductSelectionDraft[Field],
>(
  draft: ProductSelectionDraft,
  field: Field,
  value: Value | undefined
): ProductSelectionDraft => {
  if (value === undefined) {
    const nextDraft = {
      ...draft,
    };

    delete nextDraft[field];

    return nextDraft;
  }

  return {
    ...draft,
    [field]: value,
  };
};

const applyRecordedProductSelectionAction = (
  draft: ProductSelectionDraft,
  action: ProductSelectionUpdateAction
): ProductSelectionDraft => {
  switch (action.action) {
    case "changeName":
      return {
        ...draft,
        name: action.name,
      };
    case "setKey":
      return setOptionalProductSelectionField(draft, "key", action.key);
    default:
      return draft;
  }
};

const applyRecordedProductSelectionProductCountAction = (
  productCount: number,
  action: ProductSelectionUpdateAction
): number => {
  switch (action.action) {
    case "addProduct":
    case "excludeProduct":
      return productCount + 1;
    case "removeProduct":
      return Math.max(productCount - 1, 0);
    default:
      return productCount;
  }
};

const isProductSelectionRequest = (request: ClientRequest): boolean =>
  request.uriTemplate?.includes("product-selections") === true;

type StoreProductSelectionSettingDraft = NonNullable<
  StoreDraft["productSelections"]
>[number];

type StoreProductSelectionResourceIdentifier =
  StoreProductSelectionSettingDraft["productSelection"];

const productSelectionIdentifier = (
  productSelection: StoreProductSelectionResourceIdentifier
): string => {
  if (productSelection.id !== undefined && productSelection.key !== undefined) {
    throw new Error(
      "Recorded store product selection must use id or key, not both."
    );
  }

  const identifier = productSelection.id ?? productSelection.key;

  if (identifier === undefined) {
    throw new Error("Recorded store product selection requires id or key.");
  }

  return identifier;
};

const productSelectionResourcesMatch = (
  left: StoreProductSelectionResourceIdentifier,
  right: StoreProductSelectionResourceIdentifier
): boolean => {
  if (left.id !== undefined && right.id !== undefined) {
    return left.id === right.id;
  }

  if (left.key !== undefined && right.key !== undefined) {
    return left.key === right.key;
  }

  return false;
};

const recordedStoreProductSelectionSetting = (
  setting: StoreProductSelectionSettingDraft
): Store["productSelections"][number] => ({
  active: setting.active ?? false,
  productSelection: {
    id: productSelectionIdentifier(setting.productSelection),
    typeId: "product-selection",
  },
});

const recordedStore = ({
  draft,
  id,
  version,
}: {
  readonly draft: StoreDraft;
  readonly id: string;
  readonly version: number;
}): Store => ({
  countries: draft.countries ?? [],
  createdAt: "2026-01-01T00:00:00.000Z",
  distributionChannels: [],
  id,
  key: draft.key,
  languages: draft.languages ?? [],
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  ...(draft.name === undefined ? {} : { name: draft.name }),
  productSelections: (draft.productSelections ?? []).map(
    recordedStoreProductSelectionSetting
  ),
  supplyChannels: [],
  version,
});

const setOptionalStoreField = <
  const Field extends keyof StoreDraft,
  const Value extends StoreDraft[Field],
>(
  draft: StoreDraft,
  field: Field,
  value: Value | undefined
): StoreDraft => {
  if (value === undefined) {
    const nextDraft = {
      ...draft,
    };

    delete nextDraft[field];

    return nextDraft;
  }

  return {
    ...draft,
    [field]: value,
  };
};

const applyRecordedStoreAction = (
  draft: StoreDraft,
  action: StoreUpdateAction
): StoreDraft => {
  switch (action.action) {
    case "addProductSelection": {
      const nextSetting = {
        active: action.active ?? false,
        productSelection: action.productSelection,
      } satisfies StoreProductSelectionSettingDraft;
      const existingSettings = draft.productSelections ?? [];
      const remainingSettings = existingSettings.filter(
        (setting) =>
          !productSelectionResourcesMatch(
            setting.productSelection,
            action.productSelection
          )
      );

      return {
        ...draft,
        productSelections: [...remainingSettings, nextSetting],
      };
    }
    case "changeProductSelectionActive":
      return {
        ...draft,
        productSelections: (draft.productSelections ?? []).map((setting) =>
          productSelectionResourcesMatch(
            setting.productSelection,
            action.productSelection
          )
            ? {
                ...setting,
                active: action.active ?? false,
              }
            : setting
        ),
      };
    case "removeProductSelection":
      return {
        ...draft,
        productSelections: (draft.productSelections ?? []).filter(
          (setting) =>
            !productSelectionResourcesMatch(
              setting.productSelection,
              action.productSelection
            )
        ),
      };
    case "setName":
      return setOptionalStoreField(draft, "name", action.name);
    case "setProductSelections":
      return {
        ...draft,
        productSelections: action.productSelections ?? [],
      };
    default:
      return draft;
  }
};

const isStoreRequest = (request: ClientRequest): boolean =>
  request.uriTemplate?.includes("/stores") === true;

export const makeRecordingCommercetoolsApiRoot =
  (): RecordingCommercetoolsApiRoot => {
    const requests: RecordedCommercetoolsRequest[] = [];
    let createdBusinessUnitDraft: BusinessUnitDraft | undefined;
    let businessUnitVersion = 0;
    let createdCustomerDraft: CustomerDraft | undefined;
    let customerVersion = 0;
    const customObjects = new Map<string, CustomObject>();
    let createdInventoryEntryDraft: InventoryEntryDraft | undefined;
    let inventoryEntryVersion = 0;
    let createdProductSelectionDraft: ProductSelectionDraft | undefined;
    let productSelectionProductCount = 0;
    let productSelectionVersion = 0;
    let createdStoreDraft: StoreDraft | undefined;
    let storeVersion = 0;
    let createdDraft: ProductDraft | undefined;
    let published = false;
    let productVersion = 0;

    const executeUpdateRequest = (
      request: ClientRequest
    ): Promise<RecordedCommercetoolsResponse> | undefined => {
      const body = request.body;

      if (isBusinessUnitUpdate(body) && isBusinessUnitRequest(request)) {
        const draft = createdBusinessUnitDraft;

        if (draft === undefined) {
          throw new Error(
            "Recorded business unit must be created before updating"
          );
        }

        createdBusinessUnitDraft = body.actions.reduce(
          applyRecordedBusinessUnitAction,
          draft
        );
        businessUnitVersion += 1;

        return recordedResponse(
          recordedBusinessUnit({
            draft: createdBusinessUnitDraft,
            id: "recording-business-unit-id",
            version: businessUnitVersion,
          })
        );
      }

      if (isCustomerUpdate(body) && isCustomerRequest(request)) {
        const draft = createdCustomerDraft;

        if (draft === undefined) {
          throw new Error("Recorded customer must be created before updating");
        }

        createdCustomerDraft = body.actions.reduce(
          applyRecordedCustomerAction,
          draft
        );
        customerVersion += 1;

        return recordedResponse(
          recordedCustomer({
            draft: createdCustomerDraft,
            id: "recording-customer-id",
            version: customerVersion,
          })
        );
      }

      if (isInventoryEntryUpdate(body) && isInventoryRequest(request)) {
        const draft = createdInventoryEntryDraft;

        if (draft === undefined) {
          throw new Error(
            "Recorded inventory entry must be created before updating"
          );
        }

        createdInventoryEntryDraft = body.actions.reduce(
          applyRecordedInventoryEntryAction,
          draft
        );
        inventoryEntryVersion += 1;

        return recordedResponse(
          recordedInventoryEntry({
            draft: createdInventoryEntryDraft,
            id: "recording-inventory-entry-id",
            version: inventoryEntryVersion,
          })
        );
      }

      if (
        isProductSelectionUpdate(body) &&
        isProductSelectionRequest(request)
      ) {
        const draft = createdProductSelectionDraft;

        if (draft === undefined) {
          throw new Error(
            "Recorded product selection must be created before updating"
          );
        }

        createdProductSelectionDraft = body.actions.reduce(
          applyRecordedProductSelectionAction,
          draft
        );
        productSelectionProductCount = body.actions.reduce(
          applyRecordedProductSelectionProductCountAction,
          productSelectionProductCount
        );
        productSelectionVersion += 1;

        return recordedResponse(
          recordedProductSelection({
            draft: createdProductSelectionDraft,
            id: "recording-product-selection-id",
            productCount: productSelectionProductCount,
            version: productSelectionVersion,
          })
        );
      }

      if (isStoreUpdate(body) && isStoreRequest(request)) {
        const draft = createdStoreDraft;

        if (draft === undefined) {
          throw new Error("Recorded store must be created before updating");
        }

        createdStoreDraft = body.actions.reduce(
          applyRecordedStoreAction,
          draft
        );
        storeVersion += 1;

        return recordedResponse(
          recordedStore({
            draft: createdStoreDraft,
            id: "recording-store-id",
            version: storeVersion,
          })
        );
      }

      if (!isProductUpdate(body)) {
        return undefined;
      }

      const draft = createdDraft;

      if (draft === undefined) {
        throw new Error("Recorded product must be created before updating");
      }

      createdDraft = body.actions.reduce(applyRecordedProductAction, draft);
      published = body.actions.reduce((current, action) => {
        if (action.action === "publish") {
          return true;
        }

        if (action.action === "unpublish") {
          return false;
        }

        return current;
      }, published);
      productVersion += 1;

      return recordedResponse(
        recordedProduct({
          draft: createdDraft,
          id: "recording-product-id",
          published,
          version: productVersion,
        })
      );
    };

    const executeCustomObjectRequest = (
      request: ClientRequest
    ): Promise<RecordedCommercetoolsResponse> | undefined => {
      if (!isCustomObjectRequest(request)) {
        return undefined;
      }

      const body = request.body;

      if (request.method === "POST" && isCustomObjectDraft(body)) {
        const storageKey = customObjectStorageKey(body.container, body.key);
        const current = customObjects.get(storageKey);

        if (body.version === 0 && current !== undefined) {
          throw recordedConflictError(
            "Recorded Custom Object version does not match"
          );
        }

        if (
          body.version !== undefined &&
          body.version !== 0 &&
          current?.version !== body.version
        ) {
          throw recordedConflictError(
            "Recorded Custom Object version does not match"
          );
        }

        const next = recordedCustomObject({
          draft: body,
          id:
            current?.id ?? `recording-custom-object-${customObjects.size + 1}`,
          version: (current?.version ?? 0) + 1,
        });

        customObjects.set(storageKey, next);

        return recordedResponse(next);
      }

      const path = customObjectPath(request);

      if (path === undefined) {
        return undefined;
      }

      const storageKey = customObjectStorageKey(path.container, path.key);
      const current = customObjects.get(storageKey);

      if (current === undefined) {
        throw recordedNotFoundError("Recorded Custom Object was not found");
      }

      if (request.method === "GET") {
        return recordedResponse(current);
      }

      if (request.method === "DELETE") {
        const version = customObjectVersion(request);

        if (version !== current.version) {
          throw recordedConflictError(
            "Recorded Custom Object delete version does not match"
          );
        }

        customObjects.delete(storageKey);

        return recordedResponse(current);
      }

      return undefined;
    };

    const executeDraftRequest = (
      request: ClientRequest
    ): Promise<RecordedCommercetoolsResponse> => {
      const body = request.body;

      if (isBusinessUnitDraft(body)) {
        createdBusinessUnitDraft = body;
        businessUnitVersion = 1;

        return recordedResponse(
          recordedBusinessUnit({
            draft: createdBusinessUnitDraft,
            id: "recording-business-unit-id",
            version: businessUnitVersion,
          })
        );
      }

      if (isCustomerDraft(body)) {
        createdCustomerDraft = body;
        customerVersion = 1;

        return recordedResponse(
          recordedCustomerSignInResult({
            draft: createdCustomerDraft,
            id: "recording-customer-id",
            version: customerVersion,
          })
        );
      }

      if (isInventoryEntryDraft(body)) {
        createdInventoryEntryDraft = body;
        inventoryEntryVersion = 1;

        return recordedResponse(
          recordedInventoryEntry({
            draft: createdInventoryEntryDraft,
            id: "recording-inventory-entry-id",
            version: inventoryEntryVersion,
          })
        );
      }

      if (isStoreDraft(body) && isStoreRequest(request)) {
        createdStoreDraft = body;
        storeVersion = 1;

        return recordedResponse(
          recordedStore({
            draft: createdStoreDraft,
            id: "recording-store-id",
            version: storeVersion,
          })
        );
      }

      if (isProductSelectionDraft(body)) {
        createdProductSelectionDraft = body;
        productSelectionProductCount = 0;
        productSelectionVersion = 1;

        return recordedResponse(
          recordedProductSelection({
            draft: createdProductSelectionDraft,
            id: "recording-product-selection-id",
            productCount: productSelectionProductCount,
            version: productSelectionVersion,
          })
        );
      }

      if (!isProductDraft(body)) {
        throw new Error(
          "Recorded request body must be a product, business unit, customer, inventory entry, product selection, or store draft"
        );
      }

      createdDraft = body;
      published = false;
      productVersion = 1;

      return recordedResponse(
        recordedProduct({
          draft: createdDraft,
          id: "recording-product-id",
          published: false,
          version: productVersion,
        })
      );
    };

    const apiRoot = new PlatformApiRoot({
      executeRequest: (request) => {
        requests.push(recordRequest(request));

        return (
          executeCustomObjectRequest(request) ??
          executeUpdateRequest(request) ??
          executeDraftRequest(request)
        );
      },
    });

    return {
      apiRoot,
      requests,
    };
  };
