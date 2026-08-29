import type { MigrationMessage } from "migrate-sdk";
import type { MigrateTarget } from "migrate-sdk/protocol";
import { useEffect, useRef, useState } from "react";
import type { MigrationTuiRuntime } from "./runtime.ts";

const noMessages: readonly MigrationMessage[] = [];

interface CachedMessages {
  readonly messages: readonly MigrationMessage[];
  readonly signature: string;
}

interface MessageState {
  readonly generation: number;
  readonly key?: string | undefined;
  readonly loading: boolean;
  readonly messages: readonly MigrationMessage[];
}

const messageTargetKey = (target: MigrateTarget): string =>
  target.kind === "migration"
    ? `migration:${target.definitionId}`
    : `group:${target.groupId}`;

const messageSignature = (messages: readonly MigrationMessage[]): string =>
  JSON.stringify(messages);

export const useMigrationMessages = ({
  runtime,
  setError,
  target,
}: {
  readonly runtime: Pick<MigrationTuiRuntime, "listMessages">;
  readonly setError: (error: string) => void;
  readonly target: MigrateTarget | undefined;
}): {
  readonly loading: boolean;
  readonly messages: readonly MigrationMessage[];
} => {
  const [state, setState] = useState<MessageState>({
    generation: 0,
    loading: false,
    messages: noMessages,
  });
  const cacheRef = useRef(new Map<string, CachedMessages>());
  const requestsRef = useRef(
    new Map<string, Promise<readonly MigrationMessage[]>>()
  );
  const runtimeRef = useRef(runtime);
  const runtimeGenerationRef = useRef(0);

  if (runtimeRef.current !== runtime) {
    runtimeRef.current = runtime;
    runtimeGenerationRef.current += 1;
    cacheRef.current.clear();
    requestsRef.current.clear();
  }

  useEffect(() => {
    const generation = runtimeGenerationRef.current;

    if (target === undefined) {
      setState({ generation, loading: false, messages: noMessages });
      return;
    }

    const key = messageTargetKey(target);
    const cached = cacheRef.current.get(key);
    let active = true;

    setState({
      generation,
      key,
      loading: cached === undefined,
      messages: cached?.messages ?? noMessages,
    });

    let request = requestsRef.current.get(key);
    if (request === undefined) {
      request = runtime.listMessages(target);
      requestsRef.current.set(key, request);
    }

    request
      .then(
        (nextMessages) => {
          if (generation !== runtimeGenerationRef.current) {
            return;
          }

          const current = cacheRef.current.get(key);
          const signature = messageSignature(nextMessages);
          const next =
            current?.signature === signature
              ? current
              : { messages: nextMessages, signature };
          cacheRef.current.set(key, next);

          if (!active) {
            return;
          }

          setState((displayed) =>
            displayed.generation === generation &&
            displayed.key === key &&
            displayed.messages === next.messages &&
            !displayed.loading
              ? displayed
              : { generation, key, loading: false, messages: next.messages }
          );
        },
        (cause: unknown) => {
          if (!active || generation !== runtimeGenerationRef.current) {
            return;
          }

          setState((displayed) =>
            displayed.generation === generation &&
            displayed.key === key &&
            displayed.loading
              ? { ...displayed, loading: false }
              : displayed
          );
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      )
      .finally(() => {
        if (requestsRef.current.get(key) === request) {
          requestsRef.current.delete(key);
        }
      });

    return () => {
      active = false;
    };
  }, [runtime, setError, target]);

  const generation = runtimeGenerationRef.current;
  if (target === undefined) {
    return state.generation === generation && state.key === undefined
      ? state
      : { loading: false, messages: noMessages };
  }

  const key = messageTargetKey(target);
  if (state.generation === generation && state.key === key) {
    return state;
  }

  const cached = cacheRef.current.get(key);
  return {
    loading: cached === undefined,
    messages: cached?.messages ?? noMessages,
  };
};
