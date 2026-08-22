import { type Schema, SchemaRepresentation } from "effect";

const schemaContractFingerprintVersion = "effect-schema-representation@v1";

const stringifyCanonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonicalJson).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, Schema.Json>>;
    const entries = Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stringifyCanonicalJson(record[key] as Schema.Json)}`
      );

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
};

/**
 * Produces the SDK-owned durable fingerprint fragment for an Effect Schema.
 *
 * The version prefix makes changes to the representation contract explicit,
 * while canonical JSON ordering prevents object insertion order from affecting
 * persisted Migration Contracts.
 */
export const makeEffectSchemaContractFingerprint = (
  schema: Schema.Codec<unknown, unknown, never, never>
): string => {
  const document = SchemaRepresentation.toRepresentation(schema.ast);
  const json = SchemaRepresentation.toJson(document);

  return `${schemaContractFingerprintVersion}:${stringifyCanonicalJson(json)}`;
};
