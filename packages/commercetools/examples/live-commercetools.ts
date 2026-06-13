import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiRoot } from "@commercetools/platform-sdk";
import { createApiBuilderFromCtpClient } from "@commercetools/platform-sdk";
import {
  createAuthForClientCredentialsFlow,
  createClient,
  createHttpClient,
} from "@commercetools/sdk-client-v2";
import { Effect, Schema } from "effect";

export const requiredLiveCommercetoolsEnvNames = [
  "CTP_PROJECT_KEY",
  "CTP_CLIENT_ID",
  "CTP_CLIENT_SECRET",
  "CTP_AUTH_URL",
  "CTP_API_URL",
] as const;

const liveCommercetoolsEnvFilePath = join(
  dirname(fileURLToPath(import.meta.url)),
  ".env"
);
const loadedLiveCommercetoolsDotEnvPaths = new Set<string>();

export const loadLiveCommercetoolsDotEnv = (
  path = liveCommercetoolsEnvFilePath
): void => {
  if (loadedLiveCommercetoolsDotEnvPaths.has(path)) {
    return;
  }

  try {
    process.loadEnvFile(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;

    if (code !== "ENOENT") {
      throw error;
    }
  }

  loadedLiveCommercetoolsDotEnvPaths.add(path);
};

const optionalCommaSeparatedList = (value: string | undefined): string[] =>
  value === undefined || value.trim() === ""
    ? []
    : value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

export class MissingLiveCommercetoolsEnv extends Schema.TaggedErrorClass<MissingLiveCommercetoolsEnv>()(
  "MissingLiveCommercetoolsEnv",
  {
    name: Schema.String,
    message: Schema.String,
  }
) {}

const readLiveEnv = (name: string): string | undefined => {
  const value = process.env[name];

  if (value !== undefined && value.trim() !== "") {
    return value.trim();
  }

  return undefined;
};

export const requiredLiveEnv = (
  name: string,
  message = `Missing ${name}. Set ${requiredLiveCommercetoolsEnvNames.join(", ")} before running the live Commercetools example.`
): Effect.Effect<string, MissingLiveCommercetoolsEnv> => {
  loadLiveCommercetoolsDotEnv();
  const value = readLiveEnv(name);

  if (value === undefined) {
    return Effect.fail(
      new MissingLiveCommercetoolsEnv({
        message,
        name,
      })
    );
  }

  return Effect.succeed(value);
};

export const hasLiveCommercetoolsEnv = (): boolean => {
  loadLiveCommercetoolsDotEnv();

  return requiredLiveCommercetoolsEnvNames.every(
    (name) => readLiveEnv(name) !== undefined
  );
};

export const LiveCommercetoolsConfig = Schema.Struct({
  apiUrl: Schema.NonEmptyString,
  authUrl: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.NonEmptyString,
  projectKey: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.NonEmptyString),
});
export type LiveCommercetoolsConfig = typeof LiveCommercetoolsConfig.Type;

export const loadLiveCommercetoolsConfig = Effect.fn(
  "loadLiveCommercetoolsConfig"
)(function* () {
  loadLiveCommercetoolsDotEnv();

  return yield* Schema.decodeUnknownEffect(LiveCommercetoolsConfig)({
    apiUrl: yield* requiredLiveEnv("CTP_API_URL"),
    authUrl: yield* requiredLiveEnv("CTP_AUTH_URL"),
    clientId: yield* requiredLiveEnv("CTP_CLIENT_ID"),
    clientSecret: yield* requiredLiveEnv("CTP_CLIENT_SECRET"),
    projectKey: yield* requiredLiveEnv("CTP_PROJECT_KEY"),
    scopes: optionalCommaSeparatedList(readLiveEnv("CTP_SCOPES")),
  });
});

const requiredLiveEnvSync = (name: string): string => {
  loadLiveCommercetoolsDotEnv();
  const value = readLiveEnv(name);

  if (value === undefined) {
    throw new MissingLiveCommercetoolsEnv({
      message: `Missing ${name}. Set ${requiredLiveCommercetoolsEnvNames.join(", ")} before loading the live Commercetools migration config.`,
      name,
    });
  }

  return value;
};

export const loadLiveCommercetoolsConfigSync = (): LiveCommercetoolsConfig =>
  Schema.decodeUnknownSync(LiveCommercetoolsConfig)({
    apiUrl: requiredLiveEnvSync("CTP_API_URL"),
    authUrl: requiredLiveEnvSync("CTP_AUTH_URL"),
    clientId: requiredLiveEnvSync("CTP_CLIENT_ID"),
    clientSecret: requiredLiveEnvSync("CTP_CLIENT_SECRET"),
    projectKey: requiredLiveEnvSync("CTP_PROJECT_KEY"),
    scopes: optionalCommaSeparatedList(readLiveEnv("CTP_SCOPES")),
  });

export const makeLiveApiRoot = (config: LiveCommercetoolsConfig): ApiRoot => {
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
