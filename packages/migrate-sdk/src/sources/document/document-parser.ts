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
  document: unknown,
  message = "JSON document does not match document schema"
) =>
  Schema.decodeUnknownEffect(schema, {
    errors: "all",
  })(document).pipe(
    Effect.mapError((cause) =>
      documentParserError(
        message,
        parserFailureCause(parser, "document-schema", cause)
      )
    )
  );

const validateMaterializedDocument = <Document>(
  parser: string,
  schema: Schema.Codec<Document, unknown, never, never>,
  document: unknown
) =>
  Schema.encodeUnknownEffect(schema, {
    errors: "all",
  })(document).pipe(
    Effect.as(document as Document),
    Effect.mapError((cause) =>
      documentParserError(
        "Document does not match document schema",
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

const makeSchemaParser = <Document>(
  name: string,
  documentSchema: Schema.Codec<Document, unknown, never, never>
): DocumentParser<unknown, Document> => ({
  documentSchema,
  name,
  parse: (resource) =>
    validateMaterializedDocument(name, documentSchema, resource).pipe(
      Effect.map((document) => [document])
    ),
});

export const DocumentParsers = {
  json: makeJsonParser,
  schema: makeSchemaParser,
} as const;
