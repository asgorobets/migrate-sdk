import { Effect, Schema } from "effect";
import { SourcePluginError } from "../../domain/errors.ts";

export interface DocumentParser<Resource, Document> {
  readonly documentSchema: Schema.Codec<Document, unknown, never, never>;
  readonly name: string;
  readonly parse: (
    resource: Resource
  ) => Effect.Effect<readonly Document[], SourcePluginError>;
}

type DocumentParserFailureKind = "document-schema" | "json-syntax";

interface DocumentParserFailureCause {
  readonly cause: unknown;
  readonly diagnostic: string;
  readonly kind: DocumentParserFailureKind;
  readonly parser: string;
}

const documentParserError = (
  message: string,
  cause?: DocumentParserFailureCause
): SourcePluginError =>
  new SourcePluginError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const parserFailureCause = (
  parser: string,
  kind: DocumentParserFailureKind,
  cause: unknown
): DocumentParserFailureCause => ({
  cause,
  diagnostic: String(cause),
  kind,
  parser,
});

const decodeJsonResource = (parser: string, resource: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(resource).pipe(
    Effect.mapError((cause) =>
      documentParserError(
        "Unable to parse JSON document",
        parserFailureCause(parser, "json-syntax", cause)
      )
    )
  );

const decodeDocument = <Document>(
  parser: string,
  schema: Schema.Codec<Document, unknown, never, never>,
  document: unknown
) =>
  Schema.decodeUnknownEffect(schema, {
    errors: "all",
  })(document).pipe(
    Effect.mapError((cause) =>
      documentParserError(
        "JSON document does not match document schema",
        parserFailureCause(parser, "document-schema", cause)
      )
    )
  );

const makeJsonParser = <Document>(
  documentSchema: Schema.Codec<Document, unknown, never, never>
): DocumentParser<string, Document> => {
  const name = "json";

  return {
    documentSchema,
    name,
    parse: (resource) =>
      Effect.gen(function* () {
        const rawDocument = yield* decodeJsonResource(name, resource);
        const document = yield* decodeDocument(
          name,
          documentSchema,
          rawDocument
        );

        return [document];
      }),
  };
};

export const DocumentParsers = {
  json: makeJsonParser,
} as const;
