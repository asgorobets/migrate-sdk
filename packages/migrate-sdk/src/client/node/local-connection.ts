import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { layerNet } from "@effect/platform-node/NodeSocket";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { layerProtocolSocket } from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import type {
  MigrateServerInfo,
  MigrateServerInstanceId,
} from "../../protocol/index.ts";
import { MIGRATE_SDK_VERSION } from "../../version.ts";
import type { MigrateConnection } from "../connection.ts";
import { validateMigrateServerInfo } from "../connection.ts";
import { MigrateClient, type MigrateClientService } from "../index.ts";
import {
  isLocalMigrateServerAuthorizationFailure,
  LocalMigrateServerHandshakeClient,
  localAuthorizedMigrateClientLayer,
} from "./local-authorization.ts";
import {
  ensurePrivateWindowsLocalMigrateServerDirectory,
  LocalMigrateServerTcpDiscoveryJson,
  localMigrateServerLoopbackHost,
  makeLocalMigrateServerEndpoint,
  removeLocalMigrateServerEndpoint,
} from "./local-endpoint.ts";

const defaultStartupTimeoutMs = 15_000;
const windowsHandshakeTimeoutMs = 3000;

export interface LocalMigrateConnectionInput {
  /**
   * Identifies the immutable application build loaded by the local server.
   * Changing it selects a separate local server endpoint while the previous
   * endpoint drains any active Migration Runs.
   */
  readonly buildId?: string;
  readonly configPath?: string;
  readonly cwd: string;
  readonly nodeExecutable?: string;
}

export interface LocalMigrateServerBootstrapOptions {
  readonly serverEntry?: URL;
  readonly serverIdentity?: string;
  readonly startupTimeoutMs?: number;
}

const defaultServerEntry = (): URL => {
  const sourceEntry = new URL("./local-server-entry.ts", import.meta.url);
  const compiledSibling = new URL("./local-server-entry.js", import.meta.url);
  const compiledDistribution = new URL(
    "../../../dist/client/node/local-server-entry.js",
    import.meta.url
  );
  const compiledEntries = [compiledSibling, compiledDistribution];
  const runningFromInstalledPackage = fileURLToPath(import.meta.url).includes(
    `${sep}node_modules${sep}`
  );
  const entries = runningFromInstalledPackage
    ? compiledEntries
    : [compiledSibling, sourceEntry, compiledDistribution];

  return (
    entries.find((entry) => existsSync(fileURLToPath(entry))) ?? sourceEntry
  );
};

const connectionError = (cause: unknown): Error => {
  const message = cause instanceof Error ? cause.message : String(cause);

  return new Error(
    `Unable to connect to the local Migrate Server: ${message}`,
    { cause }
  );
};

class LocalMigrateServerConnectionFailure extends Error {
  override readonly cause: unknown;
  readonly discoverySnapshot: string | undefined;
  readonly removeDiscovery: boolean;

  constructor(
    cause: unknown,
    options: {
      readonly discoverySnapshot?: string | undefined;
      readonly removeDiscovery?: boolean;
    } = {}
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
    this.discoverySnapshot = options.discoverySnapshot;
    this.removeDiscovery = options.removeDiscovery ?? false;
  }
}

class LocalMigrateServerCompatibilityFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

const isSocketTransportFailure = (cause: unknown): boolean =>
  cause instanceof RpcClientError &&
  (cause.reason._tag === "SocketOpenError" ||
    cause.reason._tag === "SocketCloseError" ||
    cause.reason._tag === "SocketReadError" ||
    cause.reason._tag === "SocketWriteError");

interface LocalEndpointTarget {
  readonly authToken?: string;
  readonly discoverySnapshot?: string;
  readonly instanceId?: MigrateServerInstanceId;
  readonly options:
    | { readonly path: string }
    | { readonly host: string; readonly port: number };
}

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { readonly errno?: number };

    return error.code === "EPERM" || error.errno === 1;
  }
};

const localEndpointTarget = (endpoint: string): LocalEndpointTarget => {
  if (process.platform !== "win32") {
    return { options: { path: endpoint } };
  }

  let discoverySnapshot: string;
  try {
    discoverySnapshot = readFileSync(endpoint, "utf8");
  } catch (cause) {
    throw new LocalMigrateServerConnectionFailure(cause);
  }

  let discovery: typeof LocalMigrateServerTcpDiscoveryJson.Type;
  try {
    discovery = Schema.decodeUnknownSync(LocalMigrateServerTcpDiscoveryJson)(
      discoverySnapshot
    );
  } catch (cause) {
    throw new LocalMigrateServerConnectionFailure(cause, {
      discoverySnapshot,
      removeDiscovery: true,
    });
  }

  if (
    !Number.isSafeInteger(discovery.pid) ||
    discovery.pid < 1 ||
    !Number.isSafeInteger(discovery.port) ||
    discovery.port < 1 ||
    discovery.port > 65_535
  ) {
    throw new LocalMigrateServerConnectionFailure(
      new Error(`Invalid local Migrate Server discovery file: ${endpoint}`),
      { discoverySnapshot, removeDiscovery: true }
    );
  }
  if (!processIsRunning(discovery.pid)) {
    throw new LocalMigrateServerConnectionFailure(
      new Error(`Local Migrate Server owner is not running: ${discovery.pid}`),
      { discoverySnapshot, removeDiscovery: true }
    );
  }

  return {
    authToken: discovery.authToken,
    discoverySnapshot,
    options: { host: localMigrateServerLoopbackHost, port: discovery.port },
    instanceId: discovery.instanceId,
  };
};

export const localMigrateServerEndpoint = (
  { buildId, configPath, cwd }: LocalMigrateConnectionInput,
  options: Pick<LocalMigrateServerBootstrapOptions, "serverIdentity"> = {}
): string => {
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  const tempDirectory =
    process.platform === "win32"
      ? ensurePrivateWindowsLocalMigrateServerDirectory()
      : tmpdir();

  return makeLocalMigrateServerEndpoint(
    {
      ...(buildId === undefined ? {} : { buildId }),
      ...(configPath === undefined ? {} : { configPath }),
      cwd,
    },
    {
      platform: process.platform,
      sdkVersion: MIGRATE_SDK_VERSION,
      ...(options.serverIdentity === undefined
        ? {}
        : { serverIdentity: options.serverIdentity }),
      tempDirectory,
      user,
    }
  );
};

const connectEndpoint = async (
  endpoint: string
): Promise<MigrateConnection> => {
  const target = localEndpointTarget(endpoint);
  const ProtocolLive = layerProtocolSocket().pipe(
    Layer.provide(layerNet(target.options)),
    Layer.provide(layerNdjson)
  );
  const StandardClientLive = Layer.effect(
    LocalMigrateServerHandshakeClient,
    Effect.map(MigrateClient, (client) => ({
      GetServerInfo: client.GetServerInfo,
    }))
  ).pipe(Layer.provideMerge(MigrateClient.streamingLayer));
  const ClientLive = (
    target.authToken === undefined
      ? StandardClientLive
      : localAuthorizedMigrateClientLayer(target.authToken)
  ).pipe(Layer.provide(ProtocolLive));
  const runtime = ManagedRuntime.make(ClientLive);
  const handshakeController =
    target.instanceId === undefined ? undefined : new AbortController();
  const handshakeTimeout =
    handshakeController === undefined
      ? undefined
      : setTimeout(
          () =>
            handshakeController.abort(
              new Error("Local Migrate Server TCP handshake timed out")
            ),
          windowsHandshakeTimeoutMs
        );
  const clearHandshakeTimeout = () => {
    if (handshakeTimeout !== undefined) {
      clearTimeout(handshakeTimeout);
    }
  };
  const handshakeOptions =
    handshakeController === undefined
      ? undefined
      : { signal: handshakeController.signal };
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };

  let client: MigrateClientService;
  let handshakeClient: typeof LocalMigrateServerHandshakeClient.Service;
  try {
    client = await runtime.runPromise(MigrateClient, handshakeOptions);
    handshakeClient = await runtime.runPromise(
      LocalMigrateServerHandshakeClient,
      handshakeOptions
    );
  } catch (cause) {
    clearHandshakeTimeout();
    await dispose();
    throw new LocalMigrateServerConnectionFailure(cause, {
      discoverySnapshot: target.discoverySnapshot,
    });
  }

  let serverInfo: MigrateServerInfo;
  try {
    serverInfo = await runtime.runPromise(
      handshakeClient.GetServerInfo(),
      handshakeOptions
    );
    if (
      target.instanceId !== undefined &&
      serverInfo.instanceId !== target.instanceId
    ) {
      throw new LocalMigrateServerConnectionFailure(
        new Error(
          "Local Migrate Server identity does not match its TCP discovery file"
        ),
        {
          discoverySnapshot: target.discoverySnapshot,
          removeDiscovery: true,
        }
      );
    }
    validateMigrateServerInfo(serverInfo);
    clearHandshakeTimeout();
    return {
      client,
      dispose,
      runPromise: (effect, options?: { readonly signal?: AbortSignal }) =>
        runtime.runPromise(effect, options),
      serverInfo,
    };
  } catch (cause) {
    clearHandshakeTimeout();
    await dispose();
    const authorizationFailure =
      isLocalMigrateServerAuthorizationFailure(cause);
    if (cause instanceof LocalMigrateServerConnectionFailure) {
      throw cause;
    }
    throw handshakeController?.signal.aborted ||
      isSocketTransportFailure(cause) ||
      authorizationFailure
      ? new LocalMigrateServerConnectionFailure(cause, {
          discoverySnapshot: target.discoverySnapshot,
          removeDiscovery: authorizationFailure,
        })
      : new LocalMigrateServerCompatibilityFailure(cause);
  }
};

const removeFailedEndpoint = (endpoint: string, cause: unknown): void => {
  const expectedDiscovery =
    cause instanceof LocalMigrateServerConnectionFailure &&
    cause.removeDiscovery
      ? cause.discoverySnapshot
      : undefined;

  removeLocalMigrateServerEndpoint(
    endpoint,
    process.platform,
    expectedDiscovery
  );
};

type PublishedEndpointConnectionAttempt =
  | { readonly connection: MigrateConnection; readonly kind: "connected" }
  | {
      readonly cause?: unknown;
      readonly kind: "unavailable";
    };

const connectPublishedEndpoint = async (
  endpoint: string
): Promise<PublishedEndpointConnectionAttempt> => {
  if (!existsSync(endpoint)) {
    return { kind: "unavailable" };
  }

  try {
    return { connection: await connectEndpoint(endpoint), kind: "connected" };
  } catch (cause) {
    if (cause instanceof LocalMigrateServerCompatibilityFailure) {
      throw cause.cause;
    }
    removeFailedEndpoint(endpoint, cause);
    return {
      cause:
        cause instanceof LocalMigrateServerConnectionFailure
          ? cause.cause
          : cause,
      kind: "unavailable",
    };
  }
};

const terminateOwnedServer = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveExit) => {
    const onExit = () => resolveExit();
    child.once("exit", onExit);

    if (!child.kill("SIGKILL")) {
      child.off("exit", onExit);
      resolveExit();
    }
  });
};

const connectPersistentMigrateServer = async (
  {
    buildId,
    configPath,
    cwd,
    nodeExecutable = "node",
  }: LocalMigrateConnectionInput,
  {
    serverIdentity,
    serverEntry = defaultServerEntry(),
    startupTimeoutMs = defaultStartupTimeoutMs,
  }: LocalMigrateServerBootstrapOptions = {}
): Promise<MigrateConnection> => {
  const endpointPath = localMigrateServerEndpoint(
    {
      ...(buildId === undefined ? {} : { buildId }),
      ...(configPath === undefined ? {} : { configPath }),
      cwd,
    },
    {
      ...(serverIdentity === undefined ? {} : { serverIdentity }),
    }
  );

  try {
    return await connectEndpoint(endpointPath);
  } catch (cause) {
    if (cause instanceof LocalMigrateServerCompatibilityFailure) {
      throw connectionError(cause.cause);
    }
    removeFailedEndpoint(endpointPath, cause);
  }

  const child = spawn(
    nodeExecutable,
    [
      fileURLToPath(serverEntry),
      "--cwd",
      cwd,
      "--endpoint",
      endpointPath,
      ...(configPath === undefined ? [] : ["--config", configPath]),
    ],
    {
      cwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
    }
  );
  let startupError: unknown;
  child.once("error", (cause) => {
    startupError = cause;
  });
  child.unref();

  try {
    const deadline = Date.now() + startupTimeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (startupError !== undefined) {
        throw startupError;
      }

      const attempt = await connectPublishedEndpoint(endpointPath);
      if (attempt.kind === "connected") {
        return attempt.connection;
      }
      lastError = attempt.cause ?? lastError;

      if (child.exitCode !== null || child.signalCode !== null) {
        const finalAttempt = await connectPublishedEndpoint(endpointPath);
        if (finalAttempt.kind === "connected") {
          return finalAttempt.connection;
        }
        throw new Error(
          `Local Migrate Server exited before startup completed (${child.exitCode ?? child.signalCode})`
        );
      }

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }

    throw (
      lastError ??
      new Error(`Local Migrate Server startup exceeded ${startupTimeoutMs}ms`)
    );
  } catch (cause) {
    await terminateOwnedServer(child);
    throw connectionError(cause);
  }
};

export const connectLocalMigrateServer = (
  input: LocalMigrateConnectionInput
): Promise<MigrateConnection> => connectPersistentMigrateServer(input);

export const connectLocalMigrateServerWithBootstrap = (
  input: LocalMigrateConnectionInput,
  options: LocalMigrateServerBootstrapOptions
): Promise<MigrateConnection> => connectPersistentMigrateServer(input, options);
