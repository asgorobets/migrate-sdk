import { Context, Effect } from "effect";
import type {
  AnyConfiguredSource,
  ConfiguredSourceCursor,
  ConfiguredSourceEncodedPayload,
  ConfiguredSourceIdentityKey,
  ConfiguredSourceImplementationError,
  ConfiguredSourcePayload,
  ConfiguredSourceRequirements,
} from "../domain/definition.ts";
import { makeConfiguredSourceLayer } from "../domain/definition.ts";
import type { SourceRuntime } from "../services/source.ts";

declare const configuredSourceRuntimeServiceTypeId: unique symbol;

interface ConfiguredSourceRuntimeService<Source extends AnyConfiguredSource> {
  readonly [configuredSourceRuntimeServiceTypeId]: Source;
}

export type ConfiguredSourceRuntime<Source extends AnyConfiguredSource> =
  SourceRuntime<
    ConfiguredSourcePayload<Source>,
    ConfiguredSourceCursor<Source>,
    ConfiguredSourceEncodedPayload<Source>,
    ConfiguredSourceIdentityKey<Source>
  >;

const sourceRuntimeService = <Source extends AnyConfiguredSource>(
  source: Source
) =>
  Context.Service<
    ConfiguredSourceRuntimeService<Source>,
    ConfiguredSourceRuntime<Source>
  >(`@migrate-sdk/testing/ConfiguredSourceRuntime/${source.identity.id}`);

export const useConfiguredSource = <
  Source extends AnyConfiguredSource,
  Output,
  UseError,
  UseRequirements,
>(
  source: Source,
  use: (
    sourceRuntime: ConfiguredSourceRuntime<Source>
  ) => Effect.Effect<Output, UseError, UseRequirements>
): Effect.Effect<
  Output,
  ConfiguredSourceImplementationError<Source> | UseError,
  ConfiguredSourceRequirements<Source> | UseRequirements
> => {
  const service = sourceRuntimeService(source);

  return service
    .use(use)
    .pipe(Effect.provide(makeConfiguredSourceLayer(source, service)));
};
