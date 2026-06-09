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
  Product,
  ProductData,
  ProductDraft,
  ProductUpdate,
  ProductUpdateAction,
  ProductVariant,
} from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";

export type RecordedCommercetoolsRequestBody =
  | BusinessUnitDraft
  | BusinessUnitUpdate
  | CustomerDraft
  | CustomerUpdate
  | ProductDraft
  | ProductUpdate;

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

const isProductDraft = (value: ClientRequest["body"]): value is ProductDraft =>
  isRecord(value) &&
  "productType" in value &&
  "name" in value &&
  "slug" in value;

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
    isCustomerDraft(request.body) ||
    isCustomerUpdate(request.body)
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

export const makeRecordingCommercetoolsApiRoot =
  (): RecordingCommercetoolsApiRoot => {
    const requests: RecordedCommercetoolsRequest[] = [];
    let createdBusinessUnitDraft: BusinessUnitDraft | undefined;
    let businessUnitVersion = 0;
    let createdCustomerDraft: CustomerDraft | undefined;
    let customerVersion = 0;
    let createdDraft: ProductDraft | undefined;
    let published = false;
    let productVersion = 0;

    const apiRoot = new PlatformApiRoot({
      executeRequest: (request) => {
        requests.push(recordRequest(request));

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

          return Promise.resolve({
            body: recordedBusinessUnit({
              draft: createdBusinessUnitDraft,
              id: "recording-business-unit-id",
              version: businessUnitVersion,
            }),
          });
        }

        if (isCustomerUpdate(body) && isCustomerRequest(request)) {
          const draft = createdCustomerDraft;

          if (draft === undefined) {
            throw new Error(
              "Recorded customer must be created before updating"
            );
          }

          createdCustomerDraft = body.actions.reduce(
            applyRecordedCustomerAction,
            draft
          );
          customerVersion += 1;

          return Promise.resolve({
            body: recordedCustomer({
              draft: createdCustomerDraft,
              id: "recording-customer-id",
              version: customerVersion,
            }),
          });
        }

        if (isProductUpdate(body)) {
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

          return Promise.resolve({
            body: recordedProduct({
              draft: createdDraft,
              id: "recording-product-id",
              published,
              version: productVersion,
            }),
          });
        }

        if (isBusinessUnitDraft(body)) {
          createdBusinessUnitDraft = body;
          businessUnitVersion = 1;

          return Promise.resolve({
            body: recordedBusinessUnit({
              draft: createdBusinessUnitDraft,
              id: "recording-business-unit-id",
              version: businessUnitVersion,
            }),
          });
        }

        if (isCustomerDraft(body)) {
          createdCustomerDraft = body;
          customerVersion = 1;

          return Promise.resolve({
            body: recordedCustomerSignInResult({
              draft: createdCustomerDraft,
              id: "recording-customer-id",
              version: customerVersion,
            }),
          });
        }

        if (!isProductDraft(body)) {
          throw new Error(
            "Recorded request body must be a product, business unit, or customer draft"
          );
        }

        createdDraft = body;
        published = false;
        productVersion = 1;

        return Promise.resolve({
          body: recordedProduct({
            draft: createdDraft,
            id: "recording-product-id",
            published: false,
            version: productVersion,
          }),
        });
      },
    });

    return {
      apiRoot,
      requests,
    };
  };
