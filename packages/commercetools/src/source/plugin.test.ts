import type {
  BusinessUnit,
  BusinessUnitDraft,
  BusinessUnitPagedQueryResponse,
  Customer,
  CustomerDraft,
  CustomerPagedQueryResponse,
  Product,
  ProductDraft,
  ProductPagedQueryResponse,
} from "@commercetools/platform-sdk";
import { describe, expect, it } from "@effect/vitest";
import { CommercetoolsSourcePlugin } from "@migrate-sdk/commercetools/source";
import {
  makeScriptedCommercetoolsSdk,
  type ScriptedCommercetoolsSdkRequest,
  scriptedCommercetoolsSdkRoute,
} from "@migrate-sdk/commercetools/testing";
import { Effect, Schema } from "effect";
import { SourceIdentity, SourcePlugin, SourcePluginError } from "migrate-sdk";
import { expectTypeOf } from "vitest";

const CatalogProductSource = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
});

const CustomerSource = Schema.Struct({
  email: Schema.String,
  key: Schema.String,
});

const BusinessUnitSource = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
});

const productDraft = {
  key: "example-book",
  name: {
    "en-US": "Example Book",
  },
  productType: {
    key: "book",
    typeId: "product-type",
  },
  slug: {
    "en-US": "example-book",
  },
} satisfies ProductDraft;

const customerDraft = {
  email: "customer@example.com",
  key: "example-customer",
} satisfies CustomerDraft;

const businessUnitDraft = {
  key: "example-business-unit",
  name: "Example Business Unit",
  unitType: "Company",
} satisfies BusinessUnitDraft;

const notFoundError = (message: string): Error & { readonly statusCode: 404 } =>
  Object.assign(new Error(message), {
    body: {
      message,
      statusCode: 404,
    },
    code: 404,
    statusCode: 404,
  } as const);

const stringQueryParam = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string")
      ? value.join(" and ")
      : undefined;
  }

  return undefined;
};

const numberQueryParam = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
};

const productResponse = (draft: ProductDraft = productDraft): Product => {
  const current = {
    attributes: [],
    categories: [],
    masterVariant: {
      id: 1,
    },
    name: draft.name,
    searchKeywords: {},
    slug: draft.slug,
    variants: [],
  };

  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "recording-product-id",
    ...(draft.key === undefined ? {} : { key: draft.key }),
    lastModifiedAt: "2026-01-01T00:00:00.000Z",
    masterData: {
      current,
      hasStagedChanges: true,
      published: false,
      staged: current,
    },
    productType: {
      id: draft.productType.id ?? draft.productType.key ?? "book",
      typeId: "product-type",
    },
    version: 1,
  };
};

const customerResponse = (draft: CustomerDraft = customerDraft): Customer => ({
  addresses: [],
  authenticationMode: draft.authenticationMode ?? "Password",
  billingAddressIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  customerGroupAssignments: [],
  email: draft.email,
  id: "recording-customer-id",
  isEmailVerified: draft.isEmailVerified ?? false,
  ...(draft.key === undefined ? {} : { key: draft.key }),
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  shippingAddressIds: [],
  stores: [],
  version: 1,
});

const businessUnitResponse = (
  draft: BusinessUnitDraft = businessUnitDraft
): BusinessUnit => ({
  addresses: [],
  approvalRuleMode: "Explicit",
  associateMode: "Explicit",
  associates: [],
  billingAddressIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "recording-business-unit-id",
  key: draft.key,
  lastModifiedAt: "2026-01-01T00:00:00.000Z",
  name: draft.name,
  shippingAddressIds: [],
  status: draft.status ?? "Active",
  storeMode: "Explicit",
  topLevelUnit: {
    key: draft.key,
    typeId: "business-unit",
  },
  unitType: "Company",
  version: 1,
});

const pageResults = <Resource extends { readonly id: string }>(
  request: ScriptedCommercetoolsSdkRequest,
  resources: readonly Resource[]
): { readonly limit: number; readonly results: readonly Resource[] } => {
  const lastId = stringQueryParam(request.queryParams?.["var.lastId"]);
  const limit = numberQueryParam(request.queryParams?.limit) ?? 20;

  return {
    limit,
    results: resources
      .filter((resource) => lastId === undefined || resource.id > lastId)
      .slice(0, limit),
  };
};

const productPage = (
  request: ScriptedCommercetoolsSdkRequest,
  resources: readonly Product[]
): ProductPagedQueryResponse => {
  const page = pageResults(request, resources);

  return {
    count: page.results.length,
    limit: page.limit,
    offset: 0,
    results: [...page.results],
  };
};

const customerPage = (
  request: ScriptedCommercetoolsSdkRequest,
  resources: readonly Customer[]
): CustomerPagedQueryResponse => {
  const page = pageResults(request, resources);

  return {
    count: page.results.length,
    limit: page.limit,
    offset: 0,
    results: [...page.results],
  };
};

const businessUnitPage = (
  request: ScriptedCommercetoolsSdkRequest,
  resources: readonly BusinessUnit[]
): BusinessUnitPagedQueryResponse => {
  const page = pageResults(request, resources);

  return {
    count: page.results.length,
    limit: page.limit,
    offset: 0,
    results: [...page.results],
  };
};

const resourceByRequest = <
  Resource extends { readonly id: string; readonly key?: string },
>(
  request: ScriptedCommercetoolsSdkRequest,
  resources: readonly Resource[],
  label: string
): Resource => {
  const id = request.pathVariables?.ID;
  const key = request.pathVariables?.key;

  const resource =
    typeof id === "string"
      ? resources.find((candidate) => candidate.id === id)
      : undefined;
  const resourceByKey =
    resource === undefined && typeof key === "string"
      ? resources.find((candidate) => candidate.key === key)
      : resource;

  if (resourceByKey === undefined) {
    throw notFoundError(`Recorded ${label} was not found`);
  }

  return resourceByKey;
};

const makeSourceSdk = (
  options: {
    readonly businessUnits?: readonly BusinessUnit[];
    readonly customers?: readonly Customer[];
    readonly products?: readonly Product[];
  } = {}
) => {
  const products = options.products ?? [];
  const customers = options.customers ?? [];
  const businessUnits = options.businessUnits ?? [];

  return makeScriptedCommercetoolsSdk({
    projectKey: "recording-project",
    routes: [
      scriptedCommercetoolsSdkRoute("products.source.read").replyWith(
        (request) => productPage(request, products)
      ),
      scriptedCommercetoolsSdkRoute("products.source.readById").replyWith(
        (request) => resourceByRequest(request, products, "Product")
      ),
      scriptedCommercetoolsSdkRoute("products.source.readByKey").replyWith(
        (request) => resourceByRequest(request, products, "Product")
      ),
      scriptedCommercetoolsSdkRoute("customers.source.read").replyWith(
        (request) => customerPage(request, customers)
      ),
      scriptedCommercetoolsSdkRoute("customers.source.readById").replyWith(
        (request) => resourceByRequest(request, customers, "Customer")
      ),
      scriptedCommercetoolsSdkRoute("customers.source.readByKey").replyWith(
        (request) => resourceByRequest(request, customers, "Customer")
      ),
      scriptedCommercetoolsSdkRoute("businessUnits.source.read").replyWith(
        (request) => businessUnitPage(request, businessUnits)
      ),
      scriptedCommercetoolsSdkRoute("businessUnits.source.readById").replyWith(
        (request) => resourceByRequest(request, businessUnits, "Business Unit")
      ),
      scriptedCommercetoolsSdkRoute("businessUnits.source.readByKey").replyWith(
        (request) => resourceByRequest(request, businessUnits, "Business Unit")
      ),
    ],
  });
};

describe("CommercetoolsSourcePlugin", () => {
  it("infers SDK resources by default and SDK-typed resources in projections", () => {
    const rawProductSource = CommercetoolsSourcePlugin.products();
    const rawCustomerSource = CommercetoolsSourcePlugin.customers();
    const rawBusinessUnitSource = CommercetoolsSourcePlugin.businessUnits();
    const projectedProductSource = CommercetoolsSourcePlugin.products({
      projection: {
        schema: CatalogProductSource,
        select: (product) => {
          expectTypeOf(product).toEqualTypeOf<Product>();

          return {
            key: product.key ?? product.id,
            name: product.masterData.current.name["en-US"] ?? product.id,
          };
        },
      },
    });
    const projectedCustomerSource = CommercetoolsSourcePlugin.customers({
      projection: {
        schema: CustomerSource,
        select: (customer) => {
          expectTypeOf(customer).toEqualTypeOf<Customer>();

          return {
            email: customer.email,
            key: customer.key ?? customer.id,
          };
        },
      },
    });
    const projectedBusinessUnitSource = CommercetoolsSourcePlugin.businessUnits(
      {
        projection: {
          schema: BusinessUnitSource,
          select: (businessUnit) => {
            expectTypeOf(businessUnit).toEqualTypeOf<BusinessUnit>();

            return {
              key: businessUnit.key,
              name: businessUnit.name,
            };
          },
        },
      }
    );

    expectTypeOf<
      typeof rawProductSource.sourceSchema.Type
    >().toEqualTypeOf<Product>();
    expectTypeOf<
      typeof rawCustomerSource.sourceSchema.Type
    >().toEqualTypeOf<Customer>();
    expectTypeOf<
      typeof rawBusinessUnitSource.sourceSchema.Type
    >().toEqualTypeOf<BusinessUnit>();
    expectTypeOf<
      typeof projectedProductSource.sourceSchema.Type
    >().toEqualTypeOf<typeof CatalogProductSource.Type>();
    expectTypeOf<
      typeof projectedCustomerSource.sourceSchema.Type
    >().toEqualTypeOf<typeof CustomerSource.Type>();
    expectTypeOf<
      typeof projectedBusinessUnitSource.sourceSchema.Type
    >().toEqualTypeOf<typeof BusinessUnitSource.Type>();
  });

  it.effect(
    "reads business units with inline where variables through the entity factory",
    () =>
      Effect.gen(function* () {
        const recording = makeSourceSdk({
          businessUnits: [businessUnitResponse()],
        });
        const source = CommercetoolsSourcePlugin.businessUnits({
          batchSize: 10,
          identity: "key",
          where: "key = :businessUnitKey",
          whereVariables: {
            businessUnitKey: "example-business-unit",
          },
        }).provide(recording.layer);

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const page = yield* plugin.read(null);

        expect(plugin.identity.id).toBe("commercetools-business-unit-key@v1");
        expect(page.items[0]?.identity).toEqual(
          SourceIdentity.fromKey(plugin.identity, "example-business-unit")
        );
        expect(recording.requests[0]).toMatchObject({
          operation: "businessUnits.source.read",
          queryParams: {
            limit: 10,
            sort: "id asc",
            "var.businessUnitKey": "example-business-unit",
            where: "key = :businessUnitKey",
            withTotal: false,
          },
        });
      })
  );

  it.effect(
    "reads raw SDK products through cursor windows and looks them up by source identity",
    () =>
      Effect.gen(function* () {
        const recording = makeSourceSdk({
          products: [productResponse()],
        });
        const source = CommercetoolsSourcePlugin.products({
          batchSize: 1,
        }).provide(recording.layer);

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const firstPage = yield* plugin.read(null);
        const firstItem = firstPage.items[0];

        expect(firstPage.items).toHaveLength(1);
        expect(plugin.identity.id).toBe("commercetools-product-id@v1");
        expect(firstItem?.identity).toEqual(
          SourceIdentity.fromKey(plugin.identity, "recording-product-id")
        );
        expect(firstItem?.version).toBe("1");
        expect(firstItem?.item).toMatchObject({
          id: "recording-product-id",
          key: "example-book",
          version: 1,
        });
        expect(firstPage.nextCursor).toEqual({
          lastId: "recording-product-id",
        });

        const secondPage = yield* plugin.read(firstPage.nextCursor ?? null);

        expect(secondPage.items).toHaveLength(0);
        expect(secondPage.nextCursor).toBeUndefined();

        const lookedUp = yield* plugin.readByIdentity(
          SourceIdentity.fromKey(plugin.identity, "recording-product-id")
        );

        expect(lookedUp?.identity).toEqual(
          SourceIdentity.fromKey(plugin.identity, "recording-product-id")
        );
        expect(lookedUp?.item).toMatchObject({
          id: "recording-product-id",
          key: "example-book",
          version: 1,
        });
        expect(lookedUp?.version).toBe("1");
      })
  );

  it.effect("returns null when direct product lookup misses", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk();
      const source = CommercetoolsSourcePlugin.products().provide(
        recording.layer
      );
      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

      const lookedUp = yield* plugin.readByIdentity(
        SourceIdentity.fromKey(plugin.identity, "missing-product")
      );

      expect(lookedUp).toBeNull();
    })
  );

  it.effect("can use product key as the source identity", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        products: [productResponse()],
      });
      const source = CommercetoolsSourcePlugin.products({
        identity: "key",
      }).provide(recording.layer);

      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const page = yield* plugin.read(null);
      const lookedUp = yield* plugin.readByIdentity(
        SourceIdentity.fromKey(plugin.identity, "example-book")
      );

      expect(plugin.identity.id).toBe("commercetools-product-key@v1");
      expect(page.items[0]?.identity).toEqual(
        SourceIdentity.fromKey(plugin.identity, "example-book")
      );
      expect(lookedUp?.identity).toEqual(
        SourceIdentity.fromKey(plugin.identity, "example-book")
      );
      expect(lookedUp?.item).toMatchObject({
        id: "recording-product-id",
        key: "example-book",
      });
    })
  );

  it.effect("normalizes thrown projection errors as source plugin errors", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        products: [productResponse()],
      });
      const source = CommercetoolsSourcePlugin.products({
        projection: {
          schema: CatalogProductSource,
          select: () => {
            throw new Error("projection exploded");
          },
        },
      }).provide(recording.layer);

      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const error = yield* Effect.flip(plugin.read(null));

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe(
        "Commercetools products source projection threw"
      );
      expect(error.cause).toMatchObject({
        resourceId: "recording-product-id",
      });
    })
  );

  it.effect("projects SDK products into schema-backed source payloads", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        products: [productResponse()],
      });
      const source = CommercetoolsSourcePlugin.products({
        projection: {
          schema: CatalogProductSource,
          select: (product) => ({
            key: product.key ?? product.id,
            name: product.masterData.current.name["en-US"] ?? product.id,
          }),
        },
      }).provide(recording.layer);

      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const page = yield* plugin.read(null);

      expect(page.items[0]?.item).toEqual({
        key: "example-book",
        name: "Example Book",
      });
    })
  );

  it.effect("projects SDK customers into schema-backed source payloads", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        customers: [customerResponse()],
      });
      const source = CommercetoolsSourcePlugin.customers({
        projection: {
          schema: CustomerSource,
          select: (customer) => ({
            email: customer.email,
            key: customer.key ?? customer.id,
          }),
        },
      }).provide(recording.layer);

      const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
      const page = yield* plugin.read(null);
      const lookedUp = yield* plugin.readByIdentity(
        SourceIdentity.fromKey(plugin.identity, "recording-customer-id")
      );

      expect(page.items[0]?.identity).toEqual(
        SourceIdentity.fromKey(plugin.identity, "recording-customer-id")
      );
      expect(page.items[0]).toMatchObject({
        item: {
          email: "customer@example.com",
          key: "example-customer",
        },
        version: "1",
      });
      expect(lookedUp?.identity).toEqual(
        SourceIdentity.fromKey(plugin.identity, "recording-customer-id")
      );
    })
  );

  it.effect(
    "projects SDK business units into schema-backed source payloads",
    () =>
      Effect.gen(function* () {
        const recording = makeSourceSdk({
          businessUnits: [businessUnitResponse()],
        });
        const source = CommercetoolsSourcePlugin.businessUnits({
          projection: {
            schema: BusinessUnitSource,
            select: (businessUnit) => ({
              key: businessUnit.key,
              name: businessUnit.name,
            }),
          },
        }).provide(recording.layer);

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));
        const page = yield* plugin.read(null);
        const lookedUp = yield* plugin.readByIdentity(
          SourceIdentity.fromKey(plugin.identity, "recording-business-unit-id")
        );

        expect(page.items[0]?.identity).toEqual(
          SourceIdentity.fromKey(plugin.identity, "recording-business-unit-id")
        );
        expect(page.items[0]).toMatchObject({
          item: {
            key: "example-business-unit",
            name: "Example Business Unit",
          },
          version: "1",
        });
        expect(lookedUp?.identity).toEqual(
          SourceIdentity.fromKey(plugin.identity, "recording-business-unit-id")
        );
      })
  );
});
