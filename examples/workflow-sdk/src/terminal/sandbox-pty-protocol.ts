export interface SandboxTerminalSession {
  readonly connection: {
    readonly token: string;
    readonly url: string;
  };
  readonly start: {
    readonly args: readonly string[];
    readonly command: string;
    readonly cwd: string;
    readonly env: readonly string[];
  };
}

export interface SandboxPtyDimensions {
  readonly cols: number;
  readonly rows: number;
}

interface SandboxPtyExitMessage {
  readonly code: number;
  readonly type: "exit";
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

const isStringArray = (input: unknown): input is readonly string[] =>
  Array.isArray(input) && input.every((item) => typeof item === "string");

export const isSandboxTerminalSession = (
  input: unknown
): input is SandboxTerminalSession => {
  if (!isRecord(input)) {
    return false;
  }

  const { connection, start } = input;
  return (
    isRecord(connection) &&
    typeof connection.token === "string" &&
    typeof connection.url === "string" &&
    isRecord(start) &&
    isStringArray(start.args) &&
    typeof start.command === "string" &&
    typeof start.cwd === "string" &&
    isStringArray(start.env)
  );
};

export const makeSandboxPtyStartMessage = (
  session: SandboxTerminalSession,
  dimensions: SandboxPtyDimensions
): string =>
  JSON.stringify({
    type: "start",
    command: session.start.command,
    args: session.start.args,
    env: session.start.env,
    cwd: session.start.cwd,
    ...dimensions,
  });

export const makeSandboxPtyResizeMessage = (
  dimensions: SandboxPtyDimensions
): string => JSON.stringify({ type: "resize", ...dimensions });

export const parseSandboxPtyExitMessage = (
  input: string
): SandboxPtyExitMessage | undefined => {
  try {
    const parsed: unknown = JSON.parse(input);
    if (
      isRecord(parsed) &&
      parsed.type === "exit" &&
      typeof parsed.code === "number"
    ) {
      return { code: parsed.code, type: "exit" };
    }
  } catch {
    return;
  }

  return;
};
