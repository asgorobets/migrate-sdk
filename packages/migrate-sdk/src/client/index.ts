import {
  Context,
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
  type MigrateDashboardSnapshot,
  MigrateHttpRpcs,
  type MigrateObservationEvent,
  type MigrateObservationResumeToken,
  type MigrateProtocolError,
  MigrateStreamingRpcs,
} from "../protocol/index.ts";
import {
  type MigrateClientService,
  makeMigrateClientService,
  makeStreamingMigrateClientService,
} from "./internal/client-service.ts";

type MigrateHttpRpcClient = RpcClient<
  Rpcs<typeof MigrateHttpRpcs>,
  RpcClientError
>;

export type { MigrateClientService } from "./internal/client-service.ts";

const transientHttpStatuses = new Set([408, 429, 500, 502, 503, 504]);

const statusCodeFromCause = (cause: unknown): number | undefined => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("response" in cause) ||
    typeof cause.response !== "object" ||
    cause.response === null ||
    !("status" in cause.response) ||
    typeof cause.response.status !== "number"
  ) {
    return;
  }

  return cause.response.status;
};

const retryableHttpObservationFailure = (cause: unknown): boolean =>
  Schema.is(RpcClientError)(cause) &&
  cause.reason._tag === "HttpError" &&
  (cause.reason.kind === "TransportError" ||
    cause.reason.kind === "EmptyBodyError" ||
    (cause.reason.kind === "StatusCodeError" &&
      transientHttpStatuses.has(statusCodeFromCause(cause.reason.cause) ?? 0)));

const leasedObservation = (
  client: MigrateHttpRpcClient,
  runId: MigrationRunId
): Stream.Stream<
  MigrateObservationEvent,
  MigrateProtocolError | RpcClientError
> =>
  Stream.paginate(
    { resumeToken: undefined as MigrateObservationResumeToken | undefined },
    ({ resumeToken }) =>
      client
        .ObserveRunLease({
          ...(resumeToken === undefined ? {} : { after: resumeToken }),
          runId,
        })
        .pipe(
          Effect.retry({
            schedule: Schedule.spaced("1 second"),
            while: retryableHttpObservationFailure,
          }),
          Effect.map((lease) => {
            switch (lease.kind) {
              case "terminal":
                return [
                  [
                    ...lease.events.map((envelope) => envelope.event),
                    lease.event.event,
                  ] as readonly MigrateObservationEvent[],
                  Option.none(),
                ] as const;
              case "continuing":
                return [
                  lease.events.map((envelope) => envelope.event),
                  Option.some({ resumeToken: lease.nextResumeToken }),
                ] as const;
              case "heartbeat":
                return [
                  [] as readonly MigrateObservationEvent[],
                  Option.some({ resumeToken }),
                ] as const;
              default: {
                const unhandled: never = lease;
                return unhandled;
              }
            }
          })
        )
  );

const leasedDashboardObservation = (
  client: MigrateHttpRpcClient,
  after?: MigrateDashboardResumeToken
): Stream.Stream<
  MigrateDashboardSnapshot,
  MigrateProtocolError | RpcClientError
> =>
  Stream.paginate({ resumeToken: after }, ({ resumeToken }) =>
    client
      .ObserveDashboardLease(
        resumeToken === undefined ? {} : { after: resumeToken }
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          while: retryableHttpObservationFailure,
        }),
        Effect.map((lease) =>
          lease.kind === "heartbeat"
            ? ([
                [] as readonly MigrateDashboardSnapshot[],
                Option.some({ resumeToken }),
              ] as const)
            : ([
                [lease.snapshot] as readonly MigrateDashboardSnapshot[],
                Option.some({
                  resumeToken: lease.snapshot.resumeToken,
                }),
              ] as const)
        )
      )
  );

const makeStreamingClient = makeRpcClient(MigrateStreamingRpcs).pipe(
  Effect.map(makeStreamingMigrateClientService)
);

const makeHttpClient = makeRpcClient(MigrateHttpRpcs).pipe(
  Effect.map((client) =>
    makeMigrateClientService(
      client,
      ({ after }) => leasedDashboardObservation(client, after),
      ({ runId }) => leasedObservation(client, runId)
    )
  )
);

export class MigrateClient extends Context.Service<
  MigrateClient,
  MigrateClientService
>()("@migrate-sdk/client/MigrateClient") {
  static readonly httpLayer = Layer.effect(MigrateClient, makeHttpClient);

  static readonly streamingLayer = Layer.effect(
    MigrateClient,
    makeStreamingClient
  );
}
