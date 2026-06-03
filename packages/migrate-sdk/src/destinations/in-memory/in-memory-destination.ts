import { Effect, Layer, Schema } from "effect";
import type { ConfiguredDestinationPlugin } from "../../domain/definition.ts";
import type {
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandResult,
  DestinationCommandResultInput,
} from "../../domain/destination.ts";
import { makeDestinationCommandResult } from "../../domain/destination.ts";
import { DestinationPluginError } from "../../domain/errors.ts";
import { DestinationPlugin } from "../../services/destination-plugin.ts";

type NoServiceSchema<A extends DestinationCommand> = Schema.Schema<A> & {
  readonly DecodingServices: never;
};

export interface InMemoryDestinationExecution<C extends DestinationCommand> {
  readonly command: C;
  readonly context: DestinationCommandContext;
  readonly result: DestinationCommandResult;
}

export interface InMemoryDestinationState<C extends DestinationCommand> {
  executeAttempts: number;
  readonly executions: InMemoryDestinationExecution<C>[];
}

export interface InMemoryDestinationOptions<C extends DestinationCommand> {
  readonly commandSchema: NoServiceSchema<C>;
  readonly execute?: (
    command: C,
    context: DestinationCommandContext
  ) => DestinationCommandResultInput;
  readonly state?: InMemoryDestinationState<C>;
  readonly transientFailures?: InMemoryDestinationTransientFailures;
}

export interface InMemoryDestinationTransientFailures {
  readonly execute?: number;
}

const makeState = <
  C extends DestinationCommand,
>(): InMemoryDestinationState<C> => ({
  executeAttempts: 0,
  executions: [],
});

const transientDestinationError = (): DestinationPluginError =>
  new DestinationPluginError({
    message: "In-memory destination execute failed transiently",
  });

const makeLayer = <C extends DestinationCommand>(
  options: InMemoryDestinationOptions<C>
): Layer.Layer<DestinationPlugin> =>
  Layer.sync(DestinationPlugin, (): DestinationPlugin => {
    const state = options.state ?? makeState<C>();
    const decodeCommand = Schema.decodeUnknownEffect(options.commandSchema);
    let remainingExecuteFailures = options.transientFailures?.execute ?? 0;

    const execute = Effect.fn("InMemoryDestination.execute")(
      (
        command: DestinationCommand,
        context: DestinationCommandContext
      ): Effect.Effect<DestinationCommandResult, DestinationPluginError> =>
        Effect.gen(function* () {
          state.executeAttempts += 1;

          const typedCommand = yield* decodeCommand(command).pipe(
            Effect.mapError(
              (cause) =>
                new DestinationPluginError({
                  message: "Destination command did not match command schema",
                  cause,
                })
            )
          );

          if (remainingExecuteFailures > 0) {
            remainingExecuteFailures -= 1;
            return yield* transientDestinationError();
          }

          const result = makeDestinationCommandResult(
            options.execute?.(typedCommand, context) ?? {
              destinationIdentity: `destination:${context.sourceIdentity}`,
            }
          );

          state.executions.push({
            command: typedCommand,
            context,
            result,
          });

          return result;
        })
    );

    return { execute };
  });

const make = <C extends DestinationCommand>(
  options: InMemoryDestinationOptions<C>
): ConfiguredDestinationPlugin<C> => ({
  commandSchema: options.commandSchema,
  layer: makeLayer(options),
});

export const InMemoryDestinationPlugin = {
  make,
  makeState,
  layer: makeLayer,
} as const;
