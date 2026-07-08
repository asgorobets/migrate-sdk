import { Effect, Layer } from "effect";
import {
  Source,
  type SourceIdentityTarget,
  type SourceRuntimeImplementation,
  SourceItemTotal,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../../sdk.ts";
import type {
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsPagedQueryResponse,
  CommercetoolsProjectedEntitySourceOptions,
  CommercetoolsSourceCountQueryArgs,
  CommercetoolsSourceIdentityKey,
  ConfiguredCommercetoolsSource,
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
  makeSourceError,
  toSourceError,
} from "./source-errors.ts";

const filteredQueryTotalLimit = 10_000;

const projectResource = <EncodedPayload, Resource>(
  label: string,
  getId: (resource: Resource) => string,
  select: (resource: Resource) => EncodedPayload,
  resource: Resource
) =>
  Effect.try({
    catch: (cause) =>
      makeSourceError(`${label} source projection threw`, {
        cause,
        resourceId: getId(resource),
      }),
    try: () => select(resource),
  });

const sourceItem = <
  Payload,
  EncodedPayload,
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsProjectedEntitySourceOptions<
    Payload,
    EncodedPayload,
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
    makeSourceError(`${descriptor.label} source count returned invalid total`, {
      total,
    })
  );
};

const makeImplementation = <
  Payload,
  EncodedPayload,
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsProjectedEntitySourceOptions<
    Payload,
    EncodedPayload,
    Resource
  >,
  sdk: typeof CommercetoolsSdk.Service
): SourceRuntimeImplementation<
  EncodedPayload,
  CommercetoolsSourceCursor,
  CommercetoolsSourceIdentityKey
> => {
  const countTotal = Effect.fn(`${descriptor.label}.countTotal`)(function* () {
    const queryArgs = makeCountQueryArgs(options);
    const page = yield* descriptor
      .countPage(sdk, queryArgs)
      .pipe(Effect.mapError(toSourceError));

    return yield* countTotalFromPage(descriptor, queryArgs, page);
  });

  const read = Effect.fn(`${descriptor.label}.read`)(function* (
    cursor: CommercetoolsSourceCursor | null
  ) {
    const limit = yield* resolveBatchSize(descriptor.label, options);
    const page = yield* descriptor
      .readPage(sdk, makeReadQueryArgs(options, cursor, limit))
      .pipe(Effect.mapError(toSourceError));
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
            : Effect.fail(toSourceError(cause))
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
  Payload,
  EncodedPayload,
  Resource,
  Page extends CommercetoolsPagedQueryResponse<Resource>,
>(
  descriptor: CommercetoolsEntitySourceDescriptor<Resource, Page>,
  options: CommercetoolsProjectedEntitySourceOptions<
    Payload,
    EncodedPayload,
    Resource
  >
): ConfiguredCommercetoolsSource<Payload, EncodedPayload> => {
  const identity =
    descriptor.identity[options.identity ?? defaultSourceIdentity];

  return Source.fromLayer({
    layer: (SourceRuntime) =>
      Layer.effect(
        SourceRuntime,
        Effect.gen(function* () {
          const sdk = yield* CommercetoolsSdk;

          return SourceRuntime.of(
            makeImplementation<Payload, EncodedPayload, Resource, Page>(
              descriptor,
              options,
              sdk
            )
          );
        })
      ),
    cursorSchema: CommercetoolsSourceCursor,
    identity,
    sourceSchema: options.sourceSchema,
  });
};
