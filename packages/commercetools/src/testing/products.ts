import type {
  ApiRoot,
  ClientRequest,
  Product,
  ProductDraft,
  ProductUpdate,
  ProductUpdateAction,
} from "@commercetools/platform-sdk";
import { ApiRoot as PlatformApiRoot } from "@commercetools/platform-sdk";

export interface RecordedCommercetoolsRequest {
  readonly body?: unknown;
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

const recordRequest = (
  request: ClientRequest
): RecordedCommercetoolsRequest => ({
  ...(request.body === undefined ? {} : { body: request.body }),
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
});

const prototypeProduct = ({
  draft,
  id,
  published,
  version,
}: {
  readonly draft: ProductDraft;
  readonly id: string;
  readonly published: boolean;
  readonly version: number;
}): Product =>
  ({
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    key: draft.key,
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    masterData: {
      current: {
        categories: draft.categories ?? [],
        categoryOrderHints: draft.categoryOrderHints ?? {},
        masterVariant: {},
        name: draft.name,
        slug: draft.slug,
        variants: [],
      },
      hasStagedChanges: !published,
      published,
      staged: {
        categories: draft.categories ?? [],
        categoryOrderHints: draft.categoryOrderHints ?? {},
        masterVariant: {},
        name: draft.name,
        slug: draft.slug,
        variants: [],
      },
    },
    productType: draft.productType,
    version,
  }) as unknown as Product;

const applyPrototypeAction = (
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

        if (
          typeof body === "object" &&
          body !== null &&
          "actions" in body &&
          Array.isArray((body as ProductUpdate).actions)
        ) {
          const draft = createdDraft;

          if (draft === undefined) {
            throw new Error(
              "Prototype product must be created before updating"
            );
          }

          const update = body as ProductUpdate;
          createdDraft = update.actions.reduce(applyPrototypeAction, draft);
          published = update.actions.reduce((current, action) => {
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
            body: prototypeProduct({
              draft: createdDraft,
              id: "prototype-product-id",
              published,
              version: productVersion,
            }),
          });
        }

        createdDraft = body as ProductDraft;
        published = false;
        productVersion = 1;

        return Promise.resolve({
          body: prototypeProduct({
            draft: createdDraft,
            id: "prototype-product-id",
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
