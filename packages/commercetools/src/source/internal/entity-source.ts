import { Effect, Layer } from "effect";
import {
  type SourceIdentityTarget,
  SourceItemTotal,
  SourcePlugin,
  type SourcePluginImplementation,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../../sdk.ts";
import type {
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsPagedQueryResponse,
  CommercetoolsProjectedEntitySourceOptions,
  CommercetoolsSourceCountQueryArgs,
  CommercetoolsSourceIdentityKey,
  ConfiguredCommercetoolsSourcePlugin,
} from "../domain.ts";
import { CommercetoolsSourceCursor } from "../schemas.ts";
import {
  defaultSourceIdentity,
  makeCountQueryArgs,
  makeReadQueryArgs,
  nextCursorFromPage,
  resolveBatchSize,
  selectSourceIdentity,
} from "../selectors.ts";
import {
  isNotFoundSdkError,
  sourcePluginError,
  toSourcePluginError,
} from "./plugin-errors.ts";

const filteredQueryTotalLimit = 10_000;

const projectResource = <SourceInput, Resource>(
  label: string,
  getId: (resource: Resource) => string,
  select: (resource: Resource) => SourceInput,
  resource: Resource
) =>
  Effect.try({
    catch: (cause) =>
      sourcePluginError(`${label} source projection threw`, {
        cause,
        resourceId: getId(resource),
      }),
    try: () => select(resource),
  });

const sourceItem = <
  Source,
  SourceInput,
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsProjectedEntitySourceOptions<
    Source,
    SourceInput,
    Resource
  >,
  resource: Resource
) =>
  Effect.gen(function* () {
    const identity = yield* selectSourceIdentity(descriptor, options, resource);
    const item = yield* projectResource(
      descriptor.label,
      descriptor.getId,
      options.select,
      resource
    );

    return {
      identityKey: identity,
      item,
      version: String(descriptor.getVersion(resource)),
    };
  });

const countTotalFromPage = <
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  queryArgs: CommercetoolsSourceCountQueryArgs,
  page: Page
) => {
  const total = page.total;

  if (typeof total === "number" && Number.isInteger(total) && total >= 0) {
    if (queryArgs.where !== undefined && total >= filteredQueryTotalLimit) {
      return Effect.succeed(
        SourceItemTotal.lowerBound(total, {
          message: `${descriptor.label} source count is capped for filtered queries`,
          reason: "capped",
        })
      );
    }

    return Effect.succeed(total);
  }

  return Effect.fail(
    sourcePluginError(
      `${descriptor.label} source count returned invalid total`,
      {
        total,
      }
    )
  );
};

const makeImplementation = <
  Source,
  SourceInput,
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsProjectedEntitySourceOptions<
    Source,
    SourceInput,
    Resource
  >,
  sdk: typeof CommercetoolsSdk.Service
): SourcePluginImplementation<
  Source,
  CommercetoolsSourceCursor,
  CommercetoolsSourceIdentityKey,
  SourceInput
> => {
  const countTotal = Effect.fn(`${descriptor.label}.countTotal`)(function* () {
    const queryArgs = makeCountQueryArgs(options);
    const page = yield* descriptor
      .countPage(sdk, queryArgs)
      .pipe(Effect.mapError(toSourcePluginError));

    return yield* countTotalFromPage(descriptor, queryArgs, page);
  });

  const read = Effect.fn(`${descriptor.label}.read`)(function* (
    cursor: CommercetoolsSourceCursor | null
  ) {
    const limit = yield* resolveBatchSize(descriptor.label, options);
    const page = yield* descriptor
      .readPage(sdk, makeReadQueryArgs(options, cursor, limit))
      .pipe(Effect.mapError(toSourcePluginError));
    const items = yield* Effect.forEach(page.results, (resource) =>
      sourceItem(descriptor, options, resource)
    );
    const nextCursor = nextCursorFromPage(descriptor, page);

    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });

  const readByIdentity = Effect.fn(`${descriptor.label}.readByIdentity`)(
    function* (identity: SourceIdentityTarget<CommercetoolsSourceIdentityKey>) {
      const resource = yield* (
        (options.identity ?? defaultSourceIdentity) === "id"
          ? descriptor.readById(sdk, identity.key)
          : descriptor.readByKey(sdk, identity.key)
      ).pipe(
        Effect.catch((cause) =>
          isNotFoundSdkError(cause)
            ? Effect.succeed(null)
            : Effect.fail(toSourcePluginError(cause))
        )
      );

      return resource === null
        ? null
        : yield* sourceItem(descriptor, options, resource);
    }
  );

  return {
    countTotal,
    lookupStrategy: "direct",
    read,
    readByIdentity,
  };
};

export const makeProjectedEntitySource = <
  Source,
  SourceInput,
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsProjectedEntitySourceOptions<
    Source,
    SourceInput,
    Resource
  >
): ConfiguredCommercetoolsSourcePlugin<Source, SourceInput> => {
  const identity =
    descriptor.identity[options.identity ?? defaultSourceIdentity];

  return SourcePlugin.fromLayer({
    cursorSchema: CommercetoolsSourceCursor,
    identity,
    layer: Layer.effect(
      SourcePlugin,
      Effect.gen(function* () {
        const sdk = yield* CommercetoolsSdk;
        const source = SourcePlugin.make<
          Source,
          CommercetoolsSourceCursor,
          CommercetoolsSourceIdentityKey,
          SourceInput
        >({
          cursorSchema: CommercetoolsSourceCursor,
          identity,
          make: () =>
            makeImplementation<Source, SourceInput, Resource, Page>(
              descriptor,
              options,
              sdk
            ),
          sourceSchema: options.sourceSchema,
        });

        return yield* SourcePlugin.pipe(Effect.provide(source.layer));
      })
    ),
    sourceSchema: options.sourceSchema,
  });
};
