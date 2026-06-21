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
import { CommercetoolsSource } from "@migrate-sdk/commercetools/source";
import {
  makeScriptedCommercetoolsSdk,
  type ScriptedCommercetoolsSdkRequest,
  scriptedCommercetoolsSdkRoute,
} from "@migrate-sdk/commercetools/testing";
import { Effect, Layer, Schema } from "effect";
import {
  InMemoryMigrationStore,
  MigrationDefinition,
  MigrationProgress,
  type MigrationProgressEvent,
  Source,
  SourceError,
  SourceIdentity,
  SourceItemTotal,
} from "migrate-sdk";
import { runInlineDefinition } from "migrate-sdk/testing";
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
      scriptedCommercetoolsSdkRoute("products.source.count").replyWith(
        (request) => ({
          count: 0,
          limit: numberQueryParam(request.queryParams?.limit) ?? 0,
          offset: 0,
          results: [],
          total: products.length,
        })
      ),
      scriptedCommercetoolsSdkRoute("products.source.read").replyWith(
        (request) => productPage(request, products)
      ),
      scriptedCommercetoolsSdkRoute("customers.source.count").replyWith(
        (request) => ({
          count: 0,
          limit: numberQueryParam(request.queryParams?.limit) ?? 0,
          offset: 0,
          results: [],
          total: customers.length,
        })
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
      scriptedCommercetoolsSdkRoute("businessUnits.source.count").replyWith(
        (request) => ({
          count: 0,
          limit: numberQueryParam(request.queryParams?.limit) ?? 0,
          offset: 0,
          results: [],
          total: businessUnits.length,
        })
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

describe("CommercetoolsSource", () => {
  it("infers SDK resources by default and SDK-typed resources in projections", () => {
    const rawProductSource = CommercetoolsSource.products();
    const rawCustomerSource = CommercetoolsSource.customers();
    const rawBusinessUnitSource = CommercetoolsSource.businessUnits();
    const projectedProductSource = CommercetoolsSource.products({
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
    const projectedCustomerSource = CommercetoolsSource.customers({
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
    const projectedBusinessUnitSource = CommercetoolsSource.businessUnits({
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
    });

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
        const source = CommercetoolsSource.businessUnits({
          batchSize: 10,
          identity: "key",
          where: "key = :businessUnitKey",
          whereVariables: {
            businessUnitKey: "example-business-unit",
          },
        }).provide(recording.layer);

        const sourceService = yield* Source.pipe(Effect.provide(source.layer));
        const page = yield* sourceService.read(null);

        expect(sourceService.identity.id).toBe(
          "commercetools-business-unit-key@v1"
        );
        expect(page.items[0]?.identity).toEqual(
          SourceIdentity.fromKey(
            sourceService.identity,
            "example-business-unit"
          )
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

  it.effect("counts product totals with the configured source scope", () =>
    Effect.gen(function* () {
      let projectionCalls = 0;
      const recording = makeSourceSdk({
        products: [
          productResponse(),
          {
            ...productResponse({
              ...productDraft,
              key: "second-book",
              slug: {
                "en-US": "second-book",
              },
            }),
            id: "recording-product-id-2",
          },
        ],
      });
      const source = CommercetoolsSource.products({
        batchSize: 50,
        projection: {
          schema: CatalogProductSource,
          select: (product) => {
            projectionCalls += 1;

            return {
              key: product.key ?? product.id,
              name: product.masterData.current.name["en-US"] ?? product.id,
            };
          },
        },
        where: ["masterData(current(masterVariant(sku is defined)))"],
        whereVariables: {
          channelKey: "web",
        },
      }).provide(recording.layer);

      const sourceService = yield* Source.pipe(Effect.provide(source.layer));

      if (sourceService.countTotal === undefined) {
        throw new Error("Expected Commercetools product total count");
      }

      const total = yield* sourceService.countTotal();

      expect(total).toEqual(SourceItemTotal.known(2));
      expect(projectionCalls).toBe(0);
      expect(recording.requests).toEqual([
        expect.objectContaining({
          operation: "products.source.count",
          queryParams: {
            limit: 0,
            "var.channelKey": "web",
            where: "masterData(current(masterVariant(sku is defined)))",
            withTotal: true,
          },
        }),
      ]);
    })
  );

  it.effect("counts customer and business unit totals", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        businessUnits: [businessUnitResponse()],
        customers: [customerResponse(), customerResponse()],
      });
      const customerSource = CommercetoolsSource.customers().provide(
        recording.layer
      );
      const businessUnitSource = CommercetoolsSource.businessUnits().provide(
        recording.layer
      );
      const customerSourceService = yield* Source.pipe(
        Effect.provide(customerSource.layer)
      );
      const businessUnitSourceService = yield* Source.pipe(
        Effect.provide(businessUnitSource.layer)
      );

      if (
        customerSourceService.countTotal === undefined ||
        businessUnitSourceService.countTotal === undefined
      ) {
        throw new Error("Expected Commercetools source total counts");
      }

      const customerTotal = yield* customerSourceService.countTotal();
      const businessUnitTotal = yield* businessUnitSourceService.countTotal();

      expect(customerTotal).toEqual(SourceItemTotal.known(2));
      expect(businessUnitTotal).toEqual(SourceItemTotal.known(1));
      expect(recording.requests.map((request) => request.operation)).toEqual([
        "customers.source.count",
        "businessUnits.source.count",
      ]);
    })
  );

  it.effect("returns zero product totals", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk();
      const source = CommercetoolsSource.products().provide(recording.layer);
      const sourceService = yield* Source.pipe(Effect.provide(source.layer));

      if (sourceService.countTotal === undefined) {
        throw new Error("Expected Commercetools product total count");
      }

      const total = yield* sourceService.countTotal();

      expect(total).toEqual(SourceItemTotal.known(0));
      expect(recording.requests.map((request) => request.operation)).toEqual([
        "products.source.count",
      ]);
    })
  );

  it.effect("returns a lower-bound total for capped filtered counts", () =>
    Effect.gen(function* () {
      const recording = makeScriptedCommercetoolsSdk({
        projectKey: "recording-project",
        routes: [
          scriptedCommercetoolsSdkRoute("products.source.count").reply({
            count: 0,
            limit: 0,
            offset: 0,
            results: [],
            total: 10_000,
          }),
        ],
      });
      const source = CommercetoolsSource.products({
        where: "masterData(current(masterVariant(sku is defined)))",
      }).provide(recording.layer);
      const sourceService = yield* Source.pipe(Effect.provide(source.layer));

      if (sourceService.countTotal === undefined) {
        throw new Error("Expected Commercetools product total count");
      }

      const total = yield* sourceService.countTotal();

      expect(total).toEqual(
        SourceItemTotal.lowerBound(10_000, {
          message:
            "Commercetools products source count is capped for filtered queries",
          reason: "capped",
        })
      );
      expect(recording.requests[0]).toMatchObject({
        operation: "products.source.count",
        queryParams: {
          limit: 0,
          where: "masterData(current(masterVariant(sku is defined)))",
          withTotal: true,
        },
      });
    })
  );

  it.effect("fails total count when Commercetools omits total", () =>
    Effect.gen(function* () {
      const recording = makeScriptedCommercetoolsSdk({
        projectKey: "recording-project",
        routes: [
          scriptedCommercetoolsSdkRoute("products.source.count").reply({
            count: 0,
            limit: 0,
            offset: 0,
            results: [],
          }),
        ],
      });
      const source = CommercetoolsSource.products().provide(recording.layer);
      const sourceService = yield* Source.pipe(Effect.provide(source.layer));

      if (sourceService.countTotal === undefined) {
        throw new Error("Expected Commercetools product total count");
      }

      const error = yield* Effect.flip(sourceService.countTotal());

      expect(error).toBeInstanceOf(SourceError);
      expect(error.message).toBe(
        "Commercetools products source count returned invalid total"
      );
    })
  );

  it.effect(
    "continues migration execution when product total count fails",
    () =>
      Effect.gen(function* () {
        const countError = new Error("total endpoint failed");
        const recording = makeScriptedCommercetoolsSdk({
          projectKey: "recording-project",
          routes: [
            scriptedCommercetoolsSdkRoute("products.source.count").fail(
              countError
            ),
            scriptedCommercetoolsSdkRoute("products.source.read").replyWith(
              (request) => productPage(request, [productResponse()])
            ),
            scriptedCommercetoolsSdkRoute("products.source.readById").replyWith(
              (request) =>
                resourceByRequest(request, [productResponse()], "Product")
            ),
          ],
        });
        const source = CommercetoolsSource.products().provide(recording.layer);
        const storeState = InMemoryMigrationStore.makeState();
        const progressEvents: MigrationProgressEvent[] = [];
        const progressLayer = Layer.succeed(MigrationProgress, {
          countSourceItemTotals: true,
          emit: (event) =>
            Effect.sync(() => {
              progressEvents.push(event);
            }),
        });
        const definition = MigrationDefinition.make({
          id: "commercetools-products",
          process: () => Effect.void,
          source,
          store: InMemoryMigrationStore.layer(storeState),
        });

        const summary = yield* runInlineDefinition(definition).pipe(
          Effect.provide(progressLayer)
        );

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          failed: 0,
          migrated: 1,
          needsUpdate: 0,
          skipped: 0,
          unchanged: 0,
        });
        expect(recording.requests.map((request) => request.operation)).toEqual([
          "products.source.count",
          "products.source.read",
          "products.source.read",
        ]);
        expect(progressEvents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              definitionId: definition.id,
              kind: "source-item-total-counted",
              sourceItemTotal: expect.objectContaining({
                kind: "unknown",
                message: "Source Item total count failed",
                reason: "failed",
              }),
            }),
          ])
        );
      })
  );

  it.effect(
    "reads raw SDK products through cursor windows and looks them up by source identity",
    () =>
      Effect.gen(function* () {
        const recording = makeSourceSdk({
          products: [productResponse()],
        });
        const source = CommercetoolsSource.products({
          batchSize: 1,
        }).provide(recording.layer);

        const sourceService = yield* Source.pipe(Effect.provide(source.layer));
        const firstPage = yield* sourceService.read(null);
        const firstItem = firstPage.items[0];

        expect(firstPage.items).toHaveLength(1);
        expect(sourceService.identity.id).toBe("commercetools-product-id@v1");
        expect(firstItem?.identity).toEqual(
          SourceIdentity.fromKey(sourceService.identity, "recording-product-id")
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

        const secondPage = yield* sourceService.read(
          firstPage.nextCursor ?? null
        );

        expect(secondPage.items).toHaveLength(0);
        expect(secondPage.nextCursor).toBeUndefined();

        const lookedUp = yield* sourceService.readByIdentity(
          SourceIdentity.fromKey(sourceService.identity, "recording-product-id")
        );

        expect(lookedUp?.identity).toEqual(
          SourceIdentity.fromKey(sourceService.identity, "recording-product-id")
        );
        expect(lookedUp?.item).toMatchObject({
          id: "recording-product-id",
          key: "example-book",
          version: 1,
        });
        expect(lookedUp?.version).toBe("1");
      })
  );

  it.effect(
    "returns a final checkpoint cursor for terminal business unit pages",
    () =>
      Effect.gen(function* () {
        const businessUnits = Array.from({ length: 24 }, (_, index) => {
          const sequence = `${index + 1}`.padStart(2, "0");
          const key = `example-business-unit-${sequence}`;

          return {
            ...businessUnitResponse({
              key,
              name: `Example Business Unit ${sequence}`,
              unitType: "Company",
            }),
            id: `recording-business-unit-${sequence}`,
          } satisfies BusinessUnit;
        });
        const recording = makeSourceSdk({ businessUnits });
        const source = CommercetoolsSource.businessUnits({
          batchSize: 20,
        }).provide(recording.layer);

        const sourceService = yield* Source.pipe(Effect.provide(source.layer));
        const firstPage = yield* sourceService.read(null);
        const secondPage = yield* sourceService.read(
          firstPage.nextCursor ?? null
        );
        const thirdPage = yield* sourceService.read(
          secondPage.nextCursor ?? null
        );

        expect(firstPage.items).toHaveLength(20);
        expect(firstPage.nextCursor).toEqual({
          lastId: "recording-business-unit-20",
        });
        expect(secondPage.items).toHaveLength(4);
        expect(secondPage.nextCursor).toEqual({
          lastId: "recording-business-unit-24",
        });
        expect(thirdPage.items).toHaveLength(0);
        expect(thirdPage.nextCursor).toBeUndefined();
        expect(recording.requests).toMatchObject([
          {
            operation: "businessUnits.source.read",
            queryParams: {
              limit: 20,
              sort: "id asc",
              withTotal: false,
            },
          },
          {
            operation: "businessUnits.source.read",
            queryParams: {
              limit: 20,
              sort: "id asc",
              "var.lastId": "recording-business-unit-20",
              where: "id > :lastId",
              withTotal: false,
            },
          },
          {
            operation: "businessUnits.source.read",
            queryParams: {
              limit: 20,
              sort: "id asc",
              "var.lastId": "recording-business-unit-24",
              where: "id > :lastId",
              withTotal: false,
            },
          },
        ]);
      })
  );

  it.effect("returns null when direct product lookup misses", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk();
      const source = CommercetoolsSource.products().provide(recording.layer);
      const sourceService = yield* Source.pipe(Effect.provide(source.layer));

      const lookedUp = yield* sourceService.readByIdentity(
        SourceIdentity.fromKey(sourceService.identity, "missing-product")
      );

      expect(lookedUp).toBeNull();
    })
  );

  it.effect("can use product key as the source identity", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        products: [productResponse()],
      });
      const source = CommercetoolsSource.products({
        identity: "key",
      }).provide(recording.layer);

      const sourceService = yield* Source.pipe(Effect.provide(source.layer));
      const page = yield* sourceService.read(null);
      const lookedUp = yield* sourceService.readByIdentity(
        SourceIdentity.fromKey(sourceService.identity, "example-book")
      );

      expect(sourceService.identity.id).toBe("commercetools-product-key@v1");
      expect(page.items[0]?.identity).toEqual(
        SourceIdentity.fromKey(sourceService.identity, "example-book")
      );
      expect(lookedUp?.identity).toEqual(
        SourceIdentity.fromKey(sourceService.identity, "example-book")
      );
      expect(lookedUp?.item).toMatchObject({
        id: "recording-product-id",
        key: "example-book",
      });
    })
  );

  it.effect("normalizes thrown projection errors as source errors", () =>
    Effect.gen(function* () {
      const recording = makeSourceSdk({
        products: [productResponse()],
      });
      const source = CommercetoolsSource.products({
        projection: {
          schema: CatalogProductSource,
          select: () => {
            throw new Error("projection exploded");
          },
        },
      }).provide(recording.layer);

      const sourceService = yield* Source.pipe(Effect.provide(source.layer));
      const error = yield* Effect.flip(sourceService.read(null));

      expect(error).toBeInstanceOf(SourceError);
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
      const source = CommercetoolsSource.products({
        projection: {
          schema: CatalogProductSource,
          select: (product) => ({
            key: product.key ?? product.id,
            name: product.masterData.current.name["en-US"] ?? product.id,
          }),
        },
      }).provide(recording.layer);

      const sourceService = yield* Source.pipe(Effect.provide(source.layer));
      const page = yield* sourceService.read(null);

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
      const source = CommercetoolsSource.customers({
        projection: {
          schema: CustomerSource,
          select: (customer) => ({
            email: customer.email,
            key: customer.key ?? customer.id,
          }),
        },
      }).provide(recording.layer);

      const sourceService = yield* Source.pipe(Effect.provide(source.layer));
      const page = yield* sourceService.read(null);
      const lookedUp = yield* sourceService.readByIdentity(
        SourceIdentity.fromKey(sourceService.identity, "recording-customer-id")
      );

      expect(page.items[0]?.identity).toEqual(
        SourceIdentity.fromKey(sourceService.identity, "recording-customer-id")
      );
      expect(page.items[0]).toMatchObject({
        item: {
          email: "customer@example.com",
          key: "example-customer",
        },
        version: "1",
      });
      expect(lookedUp?.identity).toEqual(
        SourceIdentity.fromKey(sourceService.identity, "recording-customer-id")
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
        const source = CommercetoolsSource.businessUnits({
          projection: {
            schema: BusinessUnitSource,
            select: (businessUnit) => ({
              key: businessUnit.key,
              name: businessUnit.name,
            }),
          },
        }).provide(recording.layer);

        const sourceService = yield* Source.pipe(Effect.provide(source.layer));
        const page = yield* sourceService.read(null);
        const lookedUp = yield* sourceService.readByIdentity(
          SourceIdentity.fromKey(
            sourceService.identity,
            "recording-business-unit-id"
          )
        );

        expect(page.items[0]?.identity).toEqual(
          SourceIdentity.fromKey(
            sourceService.identity,
            "recording-business-unit-id"
          )
        );
        expect(page.items[0]).toMatchObject({
          item: {
            key: "example-business-unit",
            name: "Example Business Unit",
          },
          version: "1",
        });
        expect(lookedUp?.identity).toEqual(
          SourceIdentity.fromKey(
            sourceService.identity,
            "recording-business-unit-id"
          )
        );
      })
  );
});
