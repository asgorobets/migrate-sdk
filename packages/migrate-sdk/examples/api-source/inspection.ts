import { Effect, type Layer } from "effect";
import type { MigrationRunSummary } from "migrate-sdk";
import {
  JsonPlaceholderApi,
  type JsonPlaceholderApiState,
  makeJsonPlaceholderApiState,
} from "./json-placeholder-api.ts";
import { JsonPlaceholderPostSourcePlugin } from "./json-placeholder-source.ts";
import { type PostEntryFields, runApiSourceExample } from "./migration.ts";

export interface ApiSourceExampleInspectionOptions {
  readonly apiLayer?: Layer.Layer<JsonPlaceholderApi>;
  readonly state?: JsonPlaceholderApiState;
}

export interface ApiSourceExampleInspection {
  readonly commandFields: readonly PostEntryFields[];
  readonly detailCalls: readonly number[];
  readonly listCalls: number;
}

export interface ApiSourceExampleInspectionResult {
  readonly inspection: ApiSourceExampleInspection;
  readonly summary: MigrationRunSummary;
}

export const runApiSourceExampleWithInspection = Effect.fn(
  "runApiSourceExampleWithInspection"
)(function* (options?: ApiSourceExampleInspectionOptions) {
  const apiState = options?.state ?? makeJsonPlaceholderApiState();
  const apiLayer =
    options?.apiLayer ?? JsonPlaceholderApi.live({ state: apiState });
  const commandFields: PostEntryFields[] = [];

  const summary = yield* runApiSourceExample({
    recordPostEntry: (fields) => {
      commandFields.push(fields);
    },
    source: JsonPlaceholderPostSourcePlugin.make({ apiLayer }),
  });

  return {
    inspection: {
      commandFields,
      detailCalls: apiState.detailCalls,
      listCalls: apiState.listCalls,
    },
    summary,
  } satisfies ApiSourceExampleInspectionResult;
});
