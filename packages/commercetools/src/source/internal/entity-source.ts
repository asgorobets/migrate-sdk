import { Effect } from "effect";
import {
  defineSourcePlugin,
  type SourcePluginImplementation,
} from "migrate-sdk";
import { CommercetoolsSdk } from "../../sdk.ts";
import type {
  CommercetoolsEntitySourceDescriptor,
  CommercetoolsPagedQueryResponse,
  CommercetoolsProjectedEntitySourceOptions,
  ConfiguredCommercetoolsSourcePlugin,
} from "../domain.ts";
import { CommercetoolsSourceCursor } from "../schemas.ts";
import {
  defaultSourceIdentity,
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
      identity,
      item,
      version: String(descriptor.getVersion(resource)),
    };
  });

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
  >
): SourcePluginImplementation<
  Source,
  CommercetoolsSourceCursor,
  SourceInput,
  CommercetoolsSdk
> => {
  const read = Effect.fn(`${descriptor.label}.read`)(function* (
    cursor: CommercetoolsSourceCursor | null
  ) {
    const sdk = yield* CommercetoolsSdk;
    const limit = yield* resolveBatchSize(descriptor.label, options);
    const page = yield* descriptor
      .readPage(sdk, makeReadQueryArgs(options, cursor, limit))
      .pipe(Effect.mapError(toSourcePluginError));
    const items = yield* Effect.forEach(page.results, (resource) =>
      sourceItem(descriptor, options, resource)
    );
    const nextCursor = nextCursorFromPage(descriptor, page, limit);

    return {
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  });

  const readByIdentity = Effect.fn(`${descriptor.label}.readByIdentity`)(
    function* (identity: string) {
      const sdk = yield* CommercetoolsSdk;
      const resource = yield* (
        (options.identity ?? defaultSourceIdentity) === "id"
          ? descriptor.readById(sdk, identity)
          : descriptor.readByKey(sdk, identity)
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
): ConfiguredCommercetoolsSourcePlugin<Source, SourceInput> =>
  defineSourcePlugin<
    Source,
    CommercetoolsSourceCursor,
    SourceInput,
    CommercetoolsSdk
  >({
    cursorSchema: CommercetoolsSourceCursor,
    make: () =>
      makeImplementation<Source, SourceInput, Resource, Page>(
        descriptor,
        options
      ),
    sourceSchema: options.sourceSchema,
  });
