import { Effect, type Layer } from "effect";
import type { MigrationRunSummary } from "migrate-sdk";
import { InMemoryDestinationTesting } from "migrate-sdk/destinations/in-memory/testing";
import {
  JsonPlaceholderApi,
  type JsonPlaceholderApiState,
  makeJsonPlaceholderApiState,
} from "./json-placeholder-api.ts";
import { JsonPlaceholderPostSourcePlugin } from "./json-placeholder-source.ts";
import { PostEntryFields, runApiSourceExample } from "./migration.ts";

const makeInspectionFixture = () =>
  InMemoryDestinationTesting.fixtureEntries({
    contentType: "post",
    commands: {
      publishEntry: true,
      upsertEntry: { fields: PostEntryFields },
    },
  });

type InspectionFixture = ReturnType<typeof makeInspectionFixture>;
type PostUpsertCommand = Extract<
  ReturnType<InspectionFixture["executions"]>[number]["command"],
  { readonly kind: "UpsertEntry" }
>;

export interface ApiSourceExampleInspectionOptions {
  readonly apiLayer?: Layer.Layer<JsonPlaceholderApi>;
  readonly state?: JsonPlaceholderApiState;
}

export interface ApiSourceExampleInspection {
  readonly commandFields: readonly PostUpsertCommand["fields"][];
  readonly detailCalls: readonly number[];
  readonly listCalls: number;
}

export interface ApiSourceExampleInspectionResult {
  readonly inspection: ApiSourceExampleInspection;
  readonly summary: MigrationRunSummary;
}

const extractCommandFields = (fixture: InspectionFixture) =>
  fixture
    .executions()
    .flatMap((execution) =>
      execution.command.kind === "UpsertEntry" ? [execution.command.fields] : []
    );

export const runApiSourceExampleWithInspection = Effect.fn(
  "runApiSourceExampleWithInspection"
)(function* (options?: ApiSourceExampleInspectionOptions) {
  const apiState = options?.state ?? makeJsonPlaceholderApiState();
  const apiLayer =
    options?.apiLayer ?? JsonPlaceholderApi.live({ state: apiState });
  const destinationFixture = makeInspectionFixture();

  const summary = yield* runApiSourceExample({
    destination: destinationFixture.destination,
    source: JsonPlaceholderPostSourcePlugin.make({ apiLayer }),
  });

  return {
    inspection: {
      commandFields: extractCommandFields(destinationFixture),
      detailCalls: apiState.detailCalls,
      listCalls: apiState.listCalls,
    },
    summary,
  } satisfies ApiSourceExampleInspectionResult;
});
