import { fileURLToPath } from "node:url";
import { createApiBuilderFromCtpClient } from "@commercetools/platform-sdk";
import {
  createAuthForClientCredentialsFlow,
  createClient,
  createHttpClient,
} from "@commercetools/sdk-client-v2";
import { Console, Effect, Schema } from "effect";
import {
  type ProductCatalogStoreMigrationExampleResult,
  runProductCatalogStoreMigration,
} from "./product-catalog-store-migration.ts";

const optionalCommaSeparatedList = (value: string | undefined): string[] =>
  value === undefined || value.trim() === ""
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

class MissingLiveCommercetoolsEnv extends Schema.TaggedErrorClass<MissingLiveCommercetoolsEnv>()(
  "MissingLiveCommercetoolsEnv",
  {
    name: Schema.String,
    message: Schema.String,
  }
) {}

const requiredEnv = (
  name: string
): Effect.Effect<string, MissingLiveCommercetoolsEnv> => {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return Effect.fail(
      new MissingLiveCommercetoolsEnv({
        message: `Missing ${name}. Set CT_PROJECT_KEY, CT_CLIENT_ID, CT_CLIENT_SECRET, CT_AUTH_URL, and CT_API_URL before running the live Commercetools migration example.`,
        name,
      })
    );
  }

  return Effect.succeed(value);
};

const LiveCommercetoolsConfig = Schema.Struct({
  apiUrl: Schema.NonEmptyString,
  authUrl: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
  projectKey: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.NonEmptyString),
});
type LiveCommercetoolsConfig = typeof LiveCommercetoolsConfig.Type;

const loadLiveCommercetoolsConfig = Effect.fn("loadLiveCommercetoolsConfig")(
  function* () {
    return yield* Schema.decodeUnknownEffect(LiveCommercetoolsConfig)({
      apiUrl: yield* requiredEnv("CT_API_URL"),
      authUrl: yield* requiredEnv("CT_AUTH_URL"),
      clientId: yield* requiredEnv("CT_CLIENT_ID"),
      clientSecret: yield* requiredEnv("CT_CLIENT_SECRET"),
      projectKey: yield* requiredEnv("CT_PROJECT_KEY"),
      scopes: optionalCommaSeparatedList(process.env.CT_SCOPES),
    });
  }
);

const makeLiveApiRoot = (config: LiveCommercetoolsConfig) => {
  const scopes = [...config.scopes];
  const authMiddleware = createAuthForClientCredentialsFlow({
    credentials: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    fetch,
    host: config.authUrl,
    projectKey: config.projectKey,
    ...(scopes.length === 0 ? {} : { scopes }),
  });
  const httpMiddleware = createHttpClient({
    fetch,
    host: config.apiUrl,
  });
  const client = createClient({
    middlewares: [authMiddleware, httpMiddleware],
  });

  return createApiBuilderFromCtpClient(client);
};

export const runLiveProductCatalogStoreMigrationExample = Effect.fn(
  "runLiveProductCatalogStoreMigrationExample"
)(function* () {
  const config = yield* loadLiveCommercetoolsConfig();

  return yield* runProductCatalogStoreMigration({
    apiRoot: makeLiveApiRoot(config),
    projectKey: config.projectKey,
  });
});

export const formatLiveProductCatalogStoreMigrationExampleResult = (
  result: ProductCatalogStoreMigrationExampleResult
): string => {
  const definition = result.summary.definitions[0];

  return [
    "Commercetools Product Catalog Store Migration Live Example",
    `status: ${result.summary.status}`,
    `definitions: ${result.summary.definitions.length}`,
    `products migrated: ${definition?.counts.migrated ?? 0}`,
    `persisted item states: ${result.itemStates.length}`,
  ].join("\n");
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  Effect.runPromise(
    runLiveProductCatalogStoreMigrationExample().pipe(
      Effect.map(formatLiveProductCatalogStoreMigrationExampleResult),
      Effect.flatMap(Console.log)
    )
  ).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
