import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { layer as layerNodeWorker } from "@effect/platform-node/NodeWorker";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { layerProtocolWorker } from "effect/unstable/rpc/RpcClient";
import { MigrateClient, type MigrateClientService } from "migrate-sdk/client";
import {
  MIGRATE_CAPABILITIES,
  MIGRATE_PROTOCOL_VERSION,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};
const defaultStartupTimeoutMs = 10_000;
const maxDiagnosticLength = 8000;

export interface LocalMigrateRpcConnection {
  readonly client: MigrateClientService;
  readonly dispose: () => Promise<void>;
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
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

export const connectLocalMigrateServer = async ({
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
    connected = true;

    return {
      client,
      dispose,
      runPromise: (effect) => runtime.runPromise(effect),
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
