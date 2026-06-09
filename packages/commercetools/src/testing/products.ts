import type {
  ApiRoot,
  ClientRequest,
  Product,
  ProductData,
  ProductDraft,
  ProductUpdate,
  ProductUpdateAction,
  ProductVariant,
} from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";

export type RecordedCommercetoolsRequestBody = ProductDraft | ProductUpdate;

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

const isProductDraft = (value: ClientRequest["body"]): value is ProductDraft =>
  isRecord(value) &&
  "productType" in value &&
  "name" in value &&
  "slug" in value;

const requestBody = (
  request: ClientRequest
): RecordedCommercetoolsRequestBody | undefined => {
  if (isProductDraft(request.body) || isProductUpdate(request.body)) {
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

export const makeRecordingCommercetoolsApiRoot =
  (): RecordingCommercetoolsApiRoot => {
    const requests: RecordedCommercetoolsRequest[] = [];
    let createdDraft: ProductDraft | undefined;
    let published = false;
    let productVersion = 0;

    const apiRoot = new PlatformApiRoot({
      executeRequest: (request) => {
        requests.push(recordRequest(request));

        const body = request.body;

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

        if (!isProductDraft(body)) {
          throw new Error(
            "Recorded product request body must be a product draft"
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
