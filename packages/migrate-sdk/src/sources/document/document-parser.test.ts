import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SourcePluginError } from "migrate-sdk";
import type { DocumentParser } from "migrate-sdk/sources/document";
import { DocumentParsers } from "migrate-sdk/sources/document";
import { expectTypeOf } from "vitest";

const CompanyDocument = Schema.Struct({
  companies: Schema.Array(
    Schema.Struct({
      contacts: Schema.Array(
        Schema.Struct({
          email: Schema.String,
          id: Schema.String,
        })
      ),
      id: Schema.String,
    })
  ),
});

interface ParserFailureCause {
  readonly diagnostic: string;
  readonly kind: string;
  readonly parser: string;
}

describe("DocumentParsers.json", () => {
  it.effect("parses a JSON string into one schema-backed document", () =>
    Effect.gen(function* () {
      const parser = DocumentParsers.json(CompanyDocument);

      expect(parser.name).toBe("json");
      expect(parser.documentSchema).toBe(CompanyDocument);
      expectTypeOf(parser).toMatchTypeOf<
        DocumentParser<string, typeof CompanyDocument.Type>
      >();
      expectTypeOf(parser.parse("{}")).toMatchTypeOf<
        Effect.Effect<
          readonly (typeof CompanyDocument.Type)[],
          SourcePluginError
        >
      >();

      const documents = yield* parser.parse(
        JSON.stringify({
          companies: [
            {
              contacts: [{ email: "a@example.com", id: "contact-1" }],
              id: "company-1",
            },
          ],
        })
      );

      expect(documents).toEqual([
        {
          companies: [
            {
              contacts: [{ email: "a@example.com", id: "contact-1" }],
              id: "company-1",
            },
          ],
        },
      ]);
      expectTypeOf(documents).toMatchTypeOf<
        readonly (typeof CompanyDocument.Type)[]
      >();
    })
  );

  it.effect("treats a JSON root array as one parsed document", () =>
    Effect.gen(function* () {
      const ContactDocument = Schema.Array(
        Schema.Struct({
          email: Schema.String,
          id: Schema.String,
        })
      );
      const parser = DocumentParsers.json(ContactDocument);

      const documents = yield* parser.parse(
        JSON.stringify([
          { email: "a@example.com", id: "contact-1" },
          { email: "b@example.com", id: "contact-2" },
        ])
      );

      expect(documents).toHaveLength(1);
      expect(documents[0]).toEqual([
        { email: "a@example.com", id: "contact-1" },
        { email: "b@example.com", id: "contact-2" },
      ]);
    })
  );

  it.effect("distinguishes JSON syntax failures", () =>
    Effect.gen(function* () {
      const parser = DocumentParsers.json(CompanyDocument);

      const error = yield* parser.parse('{"companies"').pipe(Effect.flip);
      const cause = error.cause as ParserFailureCause;

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe("Unable to parse JSON document");
      expect(cause.kind).toBe("json-syntax");
      expect(cause.parser).toBe("json");
      expect(cause.diagnostic).toContain("SyntaxError");
      expect(cause).not.toHaveProperty("cursor");
      expect(cause).not.toHaveProperty("path");
      expect(cause).not.toHaveProperty("url");
    })
  );

  it.effect("distinguishes schema failures with issue paths", () =>
    Effect.gen(function* () {
      const parser = DocumentParsers.json(CompanyDocument);

      const error = yield* parser
        .parse(
          JSON.stringify({
            companies: [
              {
                contacts: [{ email: 404, id: "contact-1" }],
                id: "company-1",
              },
            ],
          })
        )
        .pipe(Effect.flip);
      const cause = error.cause as ParserFailureCause;

      expect(error).toBeInstanceOf(SourcePluginError);
      expect(error.message).toBe(
        "JSON document does not match document schema"
      );
      expect(cause.kind).toBe("document-schema");
      expect(cause.parser).toBe("json");
      expect(cause.diagnostic).toContain("companies");
      expect(cause.diagnostic).toContain("contacts");
      expect(cause.diagnostic).toContain("email");
      expect(cause.diagnostic).toContain("Expected string");
      expect(cause).not.toHaveProperty("cursor");
      expect(cause).not.toHaveProperty("path");
      expect(cause).not.toHaveProperty("url");
    })
  );

  it.effect(
    "does not classify schema values containing SyntaxError as JSON syntax failures",
    () =>
      Effect.gen(function* () {
        const MetricsDocument = Schema.Struct({
          count: Schema.Number,
        });
        const parser = DocumentParsers.json(MetricsDocument);

        const error = yield* parser
          .parse(JSON.stringify({ count: "SyntaxError: not a number" }))
          .pipe(Effect.flip);
        const cause = error.cause as ParserFailureCause;

        expect(error.message).toBe(
          "JSON document does not match document schema"
        );
        expect(cause.kind).toBe("document-schema");
        expect(cause.diagnostic).toContain("count");
        expect(cause.diagnostic).toContain("Expected number");
      })
  );
});
