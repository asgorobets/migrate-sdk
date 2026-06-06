import { formatMigrationRunSummary } from "../in-memory-runtime.ts";
import type { ApiSourceExampleInspectionResult } from "./inspection.ts";

export const formatApiSourceExampleResult = (
  result: ApiSourceExampleInspectionResult
): string =>
  [
    "Effect-Native API Source Example",
    formatMigrationRunSummary(result.summary),
    "",
    "JSONPlaceholder API Calls",
    `list calls: ${result.inspection.listCalls}`,
    `detail calls: ${result.inspection.detailCalls.join(", ")}`,
    "",
    "Migrated Destination Command Fields",
    ...result.inspection.commandFields.map((fields, index) =>
      [
        `post ${index + 1}: ${fields.title}`,
        `author: ${fields.authorId}`,
        `body: ${fields.body}`,
      ].join("\n")
    ),
  ].join("\n");
