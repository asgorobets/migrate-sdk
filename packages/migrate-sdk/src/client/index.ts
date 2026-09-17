import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  make as makeRpcClient,
  type RpcClient,
} from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";
import type { MigrationRunId } from "../domain/ids.ts";
import {
  type MigrateDashboardResumeToken,
  MigrateHttpRpcs,
  type MigrateObservationEvent,
  type MigrateObservationFrame,
  type MigrateObservationResumeToken,
  MigrateStreamingRpcs,
} from "../protocol/index.ts";
import {
  type MigrateClientService,
  makeMigrateClientService,
  makeStreamingMigrateClientService,
} from "./internal/client-service.ts";
import { rpcClientHttpStatusCode } from "./internal/rpc-client-error.ts";

type MigrateHttpRpcClient = RpcClient<
  Rpcs<typeof MigrateHttpRpcs>,
  RpcClientError
>;

export type { MigrateClientService } from "./internal/client-service.ts";

const transientHttpStatuses = new Set([408, 429, 500, 502, 503, 504]);

const retryableHttpObservationFailure = (cause: unknown): boolean => {
  if (!Schema.is(RpcClientError)(cause)) {
    return false;
  }
  const reason = cause.reason;
  if (reason._tag === "RpcClientDefect") {
    // Effect reports an interrupted RPC body as a protocol defect when the
    // connection ends cleanly before the RPC completion frame arrives.
    return (
      reason.message === "HTTP response ended before RPC request completed" ||
      reason.message === "Received empty HTTP response from RPC server"
    );
  }
  return (
    reason._tag === "HttpError" &&
    (reason.kind === "TransportError" ||
      reason.kind === "EmptyBodyError" ||
      // HTTP DecodeError means reading the response body failed. Malformed
      // NDJSON is a separate RpcClientDefect and must not be retried.
      reason.kind === "DecodeError" ||
      (reason.kind === "StatusCodeError" &&
        Option.exists(rpcClientHttpStatusCode(cause), (status) =>
          transientHttpStatuses.has(status)
        )))
  );
};

const observationRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Math.min(Duration.toMillis(duration), 30_000))
  ),
  Schedule.jittered
);

const observationStreamRetrySchedule = observationRetrySchedule.pipe(
  Schedule.while(({ input }) =>
    Effect.succeed(retryableHttpObservationFailure(input))
  )
);

const frameEvents = (
  frame: MigrateObservationFrame
): readonly MigrateObservationEvent[] => {
  switch (frame.kind) {
    case "heartbeat":
      return [];
    case "continuing":
      return frame.events.map(({ event }) => event);
    case "terminal":
      return [...frame.events.map(({ event }) => event), frame.event.event];
    default: {
      const unhandled: never = frame;
      return unhandled;
    }
  }
};

const sessionRunObservation = (
  client: MigrateHttpRpcClient,
  runId: MigrationRunId
) =>
  Stream.suspend(() => {
    let after: MigrateObservationResumeToken | undefined;
    return Stream.suspend(() =>
      client.ObserveRunSession({
        runId,
        ...(after === undefined ? {} : { after }),
      })
    ).pipe(
      // Heartbeats count as activity even when no migration state changes.
      Stream.timeout("45 seconds"),
      Stream.filter((frame) => frame.kind !== "heartbeat"),
      Stream.tap((frame) =>
        Effect.sync(() => {
          if (frame.kind === "continuing") {
            after = frame.nextResumeToken;
          }
        })
      ),
      Stream.retry(observationStreamRetrySchedule),
      Stream.repeat(Schedule.spaced("250 millis")),
      Stream.takeUntil((frame) => frame.kind === "terminal"),
      Stream.flatMap((frame) => Stream.fromIterable(frameEvents(frame)))
    );
  });

const sessionDashboardObservation = (
  client: MigrateHttpRpcClient,
  initialAfter?: MigrateDashboardResumeToken
) =>
  Stream.suspend(() => {
    let after = initialAfter;
    return Stream.suspend(() =>
      client.ObserveDashboardSession(after === undefined ? {} : { after })
    ).pipe(
      Stream.timeout("45 seconds"),
      Stream.filter((frame) => frame.kind === "snapshot"),
      Stream.map((frame) => frame.snapshot),
      Stream.tap((snapshot) =>
        Effect.sync(() => {
          after = snapshot.resumeToken;
        })
      ),
      Stream.retry(observationStreamRetrySchedule),
      Stream.repeat(Schedule.spaced("250 millis"))
    );
  });

const makeStreamingClient = makeRpcClient(MigrateStreamingRpcs).pipe(
  Effect.map(makeStreamingMigrateClientService)
);

export class MigrateClient extends Context.Service<
  MigrateClient,
  MigrateClientService
>()("@migrate-sdk/client/MigrateClient") {
  static readonly httpLayer = Layer.effect(
    MigrateClient,
    makeRpcClient(MigrateHttpRpcs).pipe(
      Effect.map((client) =>
        makeMigrateClientService(
          client,
          ({ after }) => sessionDashboardObservation(client, after),
          ({ runId }) => sessionRunObservation(client, runId)
        )
      )
    )
  );

  static readonly streamingLayer = Layer.effect(
    MigrateClient,
    makeStreamingClient
  );
}
