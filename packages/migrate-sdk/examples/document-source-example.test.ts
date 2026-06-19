import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  formatCompaniesDocumentSourceExampleResult,
  runCompaniesDocumentSourceExample,
} from "./document-source/companies-document-source.ts";

const exampleSourcePath = fileURLToPath(
  new URL("./document-source/companies-document-source.ts", import.meta.url)
);

describe("companies document source example", () => {
  it.effect(
    "uses the document source authoring model while preserving parent-context output",
    () =>
      Effect.gen(function* () {
        const exampleSource = readFileSync(exampleSourcePath, "utf8");
        const result = yield* runCompaniesDocumentSourceExample();
        const output = formatCompaniesDocumentSourceExampleResult(result);

        expect(exampleSource).toContain("migrate-sdk/sources/document");
        expect(result.summary.status).toBe("succeeded");
        expect(
          result.summary.definitions.map(
            (definition) => definition.definitionId
          )
        ).toEqual([
          "companies-business-units",
          "companies-contacts",
          "companies-addresses",
        ]);
        expect(result.businessUnitEntries).toHaveLength(2);
        expect(result.contactEntries).toHaveLength(3);
        expect(result.addressEntries).toHaveLength(4);
        expect(result.contactEntries.map((entry) => entry.fields)).toEqual([
          expect.objectContaining({ businessUnitName: "Orbit Labs" }),
          expect.objectContaining({ businessUnitName: "Orbit Labs" }),
          expect.objectContaining({ businessUnitName: "River Market" }),
        ]);
        expect(result.addressEntries.map((entry) => entry.fields)).toEqual([
          expect.objectContaining({ businessUnitStatus: "active" }),
          expect.objectContaining({ businessUnitStatus: "active" }),
          expect.objectContaining({ businessUnitStatus: "inactive" }),
          expect.objectContaining({ businessUnitStatus: "inactive" }),
        ]);
        expect(output).toContain("Companies Document Source Example");
        expect(output).toContain("businessUnitEntries: 2");
        expect(output).toContain("contactEntries: 3");
        expect(output).toContain("addressEntries: 4");
      })
  );
});
