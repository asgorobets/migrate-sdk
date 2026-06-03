import type { Effect } from "effect";
import * as Context from "effect/Context";
import type {
  DestinationCommand,
  DestinationCommandContext,
} from "../domain/destination.ts";
import type { DestinationPluginError } from "../domain/errors.ts";
import type { DestinationCommandResult } from "../domain/destination.ts";

export interface DestinationPlugin {
  readonly execute: (
    command: DestinationCommand,
    context: DestinationCommandContext
  ) => Effect.Effect<DestinationCommandResult, DestinationPluginError>;
}

export const DestinationPlugin =
  Context.Service<DestinationPlugin>("@migrate-sdk/DestinationPlugin");
