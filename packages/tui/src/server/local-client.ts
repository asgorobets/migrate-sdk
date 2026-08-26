import { type ChildProcess, fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { layerNet } from "@effect/platform-node/NodeSocket";
import { layer as layerNodeWorker } from "@effect/platform-node/NodeWorker";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import {
  layerProtocolSocket,
  layerProtocolWorker,
} from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import { MigrateClient, type MigrateClientService } from "migrate-sdk/client";
import {
  MIGRATE_CAPABILITIES,
  MIGRATE_PROTOCOL_VERSION,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import {
  makeLocalMigrateServerEndpoint,
  removeLocalMigrateServerEndpoint,
} from "./local-endpoint.ts";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};
const defaultStartupTimeoutMs = 10_000;
const maxDiagnosticLength = 8000;

export interface LocalMigrateRpcConnection {
  readonly client: MigrateClientService;
  readonly dispose: () => Promise<void>;
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<A>;
  readonly serverInfo: MigrateServerInfo;
}

export interface LocalMigrateRpcConnectionInput {
  readonly configPath?: string;
  readonly cwd: string;
  readonly nodeExecutable?: string;
  readonly serverEntry?: URL;
  readonly startupTimeoutMs?: number;
}

const defaultServerEntry = (): URL => {
  const compiledEntries = [
    new URL("./node-entry.js", import.meta.url),
    new URL("../../dist/server/node-entry.js", import.meta.url),
  ];

  return (
    compiledEntries.find((entry) => existsSync(fileURLToPath(entry))) ??
    new URL("./node-entry.ts", import.meta.url)
  );
};

const appendDiagnostic = (current: string, chunk: unknown): string =>
  `${current}${String(chunk)}`.slice(-maxDiagnosticLength);

const withTimeout = <Value>(
  promise: Promise<Value>,
  milliseconds: number
): Promise<Value> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`Local Migrate Server startup exceeded ${milliseconds}ms`)
      );
    }, milliseconds);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timeout);
        reject(cause);
      }
    );
  });

const connectionError = (cause: unknown, diagnostics: string): Error => {
  const detail = diagnostics.trim();
  const message = cause instanceof Error ? cause.message : String(cause);

  return new Error(
    detail === ""
      ? `Unable to connect to the local Migrate Server: ${message}`
      : `Unable to connect to the local Migrate Server: ${message}\n${detail}`,
    { cause }
  );
};

class LocalMigrateServerConnectionFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
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

const connectWorkerMigrateServer = async ({
  configPath,
  cwd,
  nodeExecutable = process.env.MIGRATE_TUI_NODE_EXECUTABLE ?? "node",
  serverEntry = defaultServerEntry(),
  startupTimeoutMs = defaultStartupTimeoutMs,
}: LocalMigrateRpcConnectionInput): Promise<LocalMigrateRpcConnection> => {
  let child: ChildProcess | undefined;
  let connected = false;
  let diagnostics = "";
  const startupFailure = Promise.withResolvers<never>();
  const WorkerLive = layerNodeWorker(() => {
    const nextChild = fork(
      serverEntry,
      [
        "--cwd",
        cwd,
        ...(configPath === undefined ? [] : ["--config", configPath]),
      ],
      {
        cwd,
        env: process.env,
        execPath: nodeExecutable,
        silent: true,
      }
    );
    child = nextChild;
    nextChild.stderr?.on("data", (chunk) => {
      diagnostics = appendDiagnostic(diagnostics, chunk);
    });
    nextChild.stdout?.on("data", (chunk) => {
      diagnostics = appendDiagnostic(diagnostics, chunk);
    });
    nextChild.once("error", startupFailure.reject);
    nextChild.once("exit", (code, signal) => {
      if (!connected) {
        startupFailure.reject(
          new Error(
            `Local Migrate Server exited before startup completed (${code ?? signal ?? "unknown"})`
          )
        );
      }
    });
    return nextChild;
  });
  const ProtocolLive = layerProtocolWorker({
    concurrency: 64,
    size: 1,
  }).pipe(Layer.provide(WorkerLive));
  const ClientLive = MigrateClient.layer.pipe(Layer.provide(ProtocolLive));
  const runtime = ManagedRuntime.make(ClientLive);
  const clientFiber = runtime.runFork(MigrateClient);
  let interruptHandshake: (() => Promise<void>) | undefined;
  let disposed = false;

  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };
  const awaitStartup = <Value>(promise: Promise<Value>): Promise<Value> =>
    withTimeout(
      Promise.race([promise, startupFailure.promise]),
      startupTimeoutMs
    );

  try {
    const client = await awaitStartup(
      Effect.runPromise(Fiber.join(clientFiber))
    );
    const handshakeFiber = runtime.runFork(client.GetServerInfo());
    interruptHandshake = () =>
      Effect.runPromise(Fiber.interrupt(handshakeFiber));
    const serverInfo = await awaitStartup(
      Effect.runPromise(Fiber.join(handshakeFiber))
    );

    validateServerInfo(serverInfo);
    connected = true;

    return {
      client,
      dispose,
      runPromise: (effect, options?: { readonly signal?: AbortSignal }) =>
        runtime.runPromise(effect, options),
      serverInfo,
    };
  } catch (cause) {
    let childExit: Promise<unknown> | undefined;
    if (child !== undefined && child.exitCode === null) {
      childExit = new Promise((resolve) => {
        child?.once("exit", resolve);
      });
      child.kill("SIGKILL");
    }

    if (childExit !== undefined) {
      await childExit;
    }
    if (interruptHandshake !== undefined) {
      await interruptHandshake();
    }
    await Effect.runPromise(Fiber.interrupt(clientFiber));
    disposed = true;
    Effect.runFork(runtime.disposeEffect);

    throw connectionError(cause, diagnostics);
  }
};

export const localMigrateServerEndpoint = ({
  configPath,
  cwd,
}: Pick<LocalMigrateRpcConnectionInput, "configPath" | "cwd">): string => {
  const user = typeof process.getuid === "function" ? process.getuid() : "user";

  return makeLocalMigrateServerEndpoint(
    {
      ...(configPath === undefined ? {} : { configPath }),
      cwd,
    },
    {
      platform: process.platform,
      sdkVersion: sdkPackage.version,
      ...(process.env.MIGRATE_TUI_SERVER_IDENTITY === undefined
        ? {}
        : {
            serverIdentity: process.env.MIGRATE_TUI_SERVER_IDENTITY,
          }),
      tempDirectory: tmpdir(),
      user,
    }
  );
};

const validateServerInfo = (serverInfo: MigrateServerInfo): void => {
  if (serverInfo.protocolVersion !== MIGRATE_PROTOCOL_VERSION) {
    throw new Error(
      `Migrate Protocol version ${serverInfo.protocolVersion} is not supported; expected ${MIGRATE_PROTOCOL_VERSION}`
    );
  }
  if (serverInfo.sdkVersion !== sdkPackage.version) {
    throw new Error(
      `Migrate SDK version ${serverInfo.sdkVersion} is not supported; expected ${sdkPackage.version}`
    );
  }

  const missingCapabilities = MIGRATE_CAPABILITIES.filter(
    (capability) => !serverInfo.capabilities.includes(capability)
  );

  if (missingCapabilities.length > 0) {
    throw new Error(
      `Local Migrate Server is missing required capabilities: ${missingCapabilities.join(", ")}`
    );
  }
};

const connectSocket = async (
  socketPath: string
): Promise<LocalMigrateRpcConnection> => {
  const ProtocolLive = layerProtocolSocket().pipe(
    Layer.provide(layerNet({ path: socketPath })),
    Layer.provide(layerNdjson)
  );
  const ClientLive = MigrateClient.layer.pipe(Layer.provide(ProtocolLive));
  const runtime = ManagedRuntime.make(ClientLive);
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };

  let client: MigrateClientService;
  try {
    client = await runtime.runPromise(MigrateClient);
  } catch (cause) {
    await dispose();
    throw new LocalMigrateServerConnectionFailure(cause);
  }

  let serverInfo: MigrateServerInfo;
  try {
    serverInfo = await runtime.runPromise(client.GetServerInfo());
    validateServerInfo(serverInfo);
    return {
      client,
      dispose,
      runPromise: (effect, options?: { readonly signal?: AbortSignal }) =>
        runtime.runPromise(effect, options),
      serverInfo,
    };
  } catch (cause) {
    await dispose();
    throw isSocketTransportFailure(cause)
      ? new LocalMigrateServerConnectionFailure(cause)
      : new LocalMigrateServerCompatibilityFailure(cause);
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

const connectPersistentMigrateServer = async ({
  configPath,
  cwd,
  nodeExecutable = process.env.MIGRATE_TUI_NODE_EXECUTABLE ?? "node",
  startupTimeoutMs = defaultStartupTimeoutMs,
}: LocalMigrateRpcConnectionInput): Promise<LocalMigrateRpcConnection> => {
  const socketPath = localMigrateServerEndpoint({
    ...(configPath === undefined ? {} : { configPath }),
    cwd,
  });

  try {
    return await connectSocket(socketPath);
  } catch (cause) {
    if (cause instanceof LocalMigrateServerCompatibilityFailure) {
      throw connectionError(cause.cause, "");
    }
    removeLocalMigrateServerEndpoint(socketPath);
  }

  const entry = defaultServerEntry();
  const child = spawn(
    nodeExecutable,
    [
      fileURLToPath(entry),
      "--cwd",
      cwd,
      "--socket",
      socketPath,
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
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Local Migrate Server exited before startup completed (${child.exitCode ?? child.signalCode})`
        );
      }

      try {
        return await connectSocket(socketPath);
      } catch (cause) {
        if (cause instanceof LocalMigrateServerCompatibilityFailure) {
          throw cause.cause;
        }
        lastError =
          cause instanceof LocalMigrateServerConnectionFailure
            ? cause.cause
            : cause;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }

    throw (
      lastError ??
      new Error(`Local Migrate Server startup exceeded ${startupTimeoutMs}ms`)
    );
  } catch (cause) {
    await terminateOwnedServer(child);
    throw connectionError(cause, "");
  }
};

export const connectLocalMigrateServer = (
  input: LocalMigrateRpcConnectionInput
): Promise<LocalMigrateRpcConnection> =>
  input.serverEntry === undefined
    ? connectPersistentMigrateServer(input)
    : connectWorkerMigrateServer(input);
