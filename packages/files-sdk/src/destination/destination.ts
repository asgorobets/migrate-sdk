import { createHash } from "node:crypto";
import { Effect, Exit, type Layer, Schema } from "effect";
import type { Body, CopyOptions, UploadOptions } from "files-sdk";
import { Files, type FilesService } from "files-sdk/effect";
import {
  DestinationChangeDescriptor,
  DestinationError,
  Tracking,
} from "migrate-sdk";
import {
  contentHash,
  objectFromInfo,
  safeFailure,
  sameObject,
} from "../internal/files.ts";
import { FilesSDKObject } from "../object.ts";

const Change = Schema.Struct({
  storageId: Schema.NonEmptyString,
  key: Schema.NonEmptyString,
  size: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  etag: Schema.optionalKey(Schema.String),
  sourceKey: Schema.optionalKey(Schema.String),
});

const changes = {
  uploaded: DestinationChangeDescriptor.make("files.object.uploaded", Change),
  copied: DestinationChangeDescriptor.make("files.object.copied", Change),
  deleted: DestinationChangeDescriptor.make("files.object.deleted", Change),
} as const;

export type FilesSDKWritePolicy =
  | { readonly kind: "overwrite" }
  | { readonly kind: "create" }
  | { readonly kind: "replace"; readonly etag: string };

export interface FilesSDKDestinationOptions {
  readonly storageId: string;
}

export interface FilesSDKUploadInput {
  readonly body:
    | Exclude<Body, ReadableStream<Uint8Array>>
    | (() => Effect.Effect<Body, DestinationError>);
  readonly cacheControl?: string;
  readonly contentType?: string;
  readonly key: string;
  readonly metadata?: Record<string, string>;
  readonly write: FilesSDKWritePolicy;
}

export interface FilesSDKTransferInput {
  readonly key: string;
  readonly metadata?: "preserve" | "omit";
  readonly object: FilesSDKObject;
  readonly source: FilesService;
  readonly verify?: "sha256";
  /** Streaming transfers require overwrite. */
  readonly write: { readonly kind: "overwrite" };
}

export interface FilesSDKCopyInput {
  readonly from: string;
  readonly key: string;
  readonly sourceEtag?: string;
  readonly write: FilesSDKWritePolicy;
}

export interface FilesSDKDeleteInput {
  readonly key: string;
  readonly policy:
    | { readonly kind: "exact"; readonly etag: string }
    | { readonly kind: "owned-prefix"; readonly prefix: string };
}

function destinationError(operation: string, error?: unknown) {
  return new DestinationError({
    message: `Files destination ${operation} failed`,
    ...(error === undefined ? {} : { cause: safeFailure(error) }),
  });
}

function uploadOptions(input: FilesSDKUploadInput): UploadOptions {
  return {
    ...(input.contentType === undefined
      ? {}
      : { contentType: input.contentType }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.cacheControl === undefined
      ? {}
      : { cacheControl: input.cacheControl }),
    ...(input.write.kind === "overwrite"
      ? {}
      : {
          multipart: false,
          condition:
            input.write.kind === "create"
              ? { type: "create" as const }
              : { type: "replace" as const, etag: input.write.etag },
        }),
  };
}

function make(options: FilesSDKDestinationOptions) {
  function record(
    descriptor: typeof changes.uploaded,
    value: {
      readonly storageId: string;
      readonly key: string;
      readonly size?: number | undefined;
      readonly etag?: string | undefined;
      readonly sourceKey?: string | undefined;
    }
  ) {
    return Tracking.recordChange(descriptor, {
      storageId: value.storageId,
      key: value.key,
      ...(value.size === undefined ? {} : { size: value.size }),
      ...(value.etag === undefined ? {} : { etag: value.etag }),
      ...(value.sourceKey === undefined ? {} : { sourceKey: value.sourceKey }),
    }).pipe(Effect.mapError(() => destinationError("journal validation")));
  }

  function diagnose(operation: string, key: string, error: unknown) {
    const facts = safeFailure(error);
    return Effect.gen(function* () {
      if (facts.applied === true) {
        let descriptor = changes.uploaded;
        if (operation === "copy") {
          descriptor = changes.copied;
        } else if (operation === "delete") {
          descriptor = changes.deleted;
        }
        yield* record(descriptor, {
          storageId: options.storageId,
          key,
          ...(typeof facts.appliedEtag === "string"
            ? { etag: facts.appliedEtag }
            : {}),
        });
      }
      yield* Tracking.logDiagnostic({
        severity: "error",
        message: `Files ${operation} failed; reconcile the destination before retrying an uncertain mutation`,
        details: { operation, key, ...facts },
      }).pipe(Effect.mapError(() => destinationError("diagnostic validation")));
    });
  }

  const configured = Effect.gen(function* () {
    if (!options.storageId.trim()) {
      return yield* destinationError("storageId must not be empty");
    }
    return yield* Files;
  });

  const upload = Effect.fn("FilesSDKDestination.upload")(function* (
    input: FilesSDKUploadInput
  ) {
    const files = yield* configured;
    const body =
      typeof input.body === "function"
        ? yield* Effect.suspend(input.body)
        : input.body;
    if (input.write.kind !== "overwrite" && body instanceof ReadableStream) {
      return yield* destinationError(
        "conditional uploads require replayable buffered bodies"
      );
    }
    const info = yield* files
      .upload(input.key, body, uploadOptions(input))
      .pipe(
        Effect.tapError((error) => diagnose("upload", input.key, error)),
        Effect.mapError((error) => destinationError("upload", error))
      );
    const object = yield* Schema.decodeUnknownEffect(FilesSDKObject)(
      objectFromInfo(options.storageId, info)
    ).pipe(Effect.mapError(() => destinationError("invalid upload metadata")));
    yield* record(changes.uploaded, object);
    return object;
  });

  const transferFrom = Effect.fn("FilesSDKDestination.transferFrom")(function* (
    input: FilesSDKTransferInput
  ) {
    const files = yield* configured;
    if (input.write.kind !== "overwrite") {
      return yield* destinationError("streaming transfer requires overwrite");
    }
    const expected = yield* Schema.decodeUnknownEffect(FilesSDKObject)(
      input.object
    ).pipe(Effect.mapError(() => destinationError("invalid source reference")));
    const file = yield* input.source
      .download(expected.key, {
        ...(expected.etag !== undefined &&
        input.source.capabilities.conditional.exactRead
          ? { condition: { etag: expected.etag } }
          : {}),
      })
      .pipe(
        Effect.mapError((error) => destinationError("source download", error))
      );
    if (!sameObject(expected, file)) {
      yield* Effect.promise(() =>
        file.file
          .stream()
          .cancel()
          .catch(() => undefined)
      );
      return yield* destinationError("source changed before transfer");
    }
    const digest = createHash("sha256");
    let bytesRead = 0;
    let sourceEnded = false;
    const { info, sourceComplete } = yield* Effect.acquireUseRelease(
      Effect.sync(() => file.file.stream().getReader()),
      (reader) => {
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              sourceEnded = true;
            } else {
              digest.update(next.value);
              bytesRead += next.value.byteLength;
              controller.enqueue(next.value);
            }
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return files
          .upload(input.key, body, {
            contentType: file.contentType,
            ...(input.metadata === "omit" || file.metadata === undefined
              ? {}
              : { metadata: { ...file.metadata } }),
          })
          .pipe(
            Effect.tapError((error) => diagnose("transfer", input.key, error)),
            Effect.mapError((error) => destinationError("transfer", error)),
            // Capture completion before cleanup cancels any pending source read.
            Effect.map((info) => ({ info, sourceComplete: sourceEnded }))
          );
      },
      (reader) =>
        Effect.promise(() => reader.cancel().catch(() => undefined)).pipe(
          Effect.andThen(Effect.sync(() => reader.releaseLock()))
        )
    );
    const object = objectFromInfo(options.storageId, info);
    yield* record(changes.uploaded, object);
    if (!sourceComplete) {
      return yield* destinationError(
        "source stream was not fully consumed; destination upload was applied"
      );
    }
    if (bytesRead !== expected.size || info.size !== expected.size) {
      return yield* destinationError(
        "transferred size mismatch; destination upload was applied"
      );
    }
    const current = yield* input.source
      .head(expected.key)
      .pipe(
        Effect.mapError((error) =>
          destinationError("source verification", error)
        )
      );
    if (!sameObject(expected, current)) {
      return yield* destinationError(
        "source changed during transfer; destination upload was applied"
      );
    }
    if (input.verify === "sha256") {
      const actual = yield* contentHash(files, object).pipe(
        Effect.mapError((error) => destinationError("checksum read", error))
      );
      if (actual !== digest.digest("hex")) {
        return yield* destinationError(
          "checksum mismatch; destination upload was applied"
        );
      }
    }
    return object;
  });

  const copy = Effect.fn("FilesSDKDestination.copy")(function* (
    input: FilesSDKCopyInput
  ) {
    const files = yield* configured;
    const opts: CopyOptions = {};
    if (input.write.kind !== "overwrite") {
      if (input.sourceEtag === undefined) {
        return yield* destinationError("conditional copy requires sourceEtag");
      }
      opts.condition = {
        source: { etag: input.sourceEtag },
        destination:
          input.write.kind === "create"
            ? { type: "create" }
            : { type: "replace", etag: input.write.etag },
      };
    } else if (input.sourceEtag !== undefined) {
      return yield* destinationError(
        "sourceEtag requires a conditional destination copy policy"
      );
    }
    yield* files.copy(input.from, input.key, opts).pipe(
      Effect.tapError((error) => diagnose("copy", input.key, error)),
      Effect.mapError((error) => destinationError("copy", error))
    );
    const info = yield* files.head(input.key).pipe(
      Effect.mapError((error) => destinationError("copy metadata", error)),
      // Journal once, retaining the acknowledged copy even on interruption.
      Effect.onExit((exit) =>
        record(changes.copied, {
          storageId: options.storageId,
          key: input.key,
          sourceKey: input.from,
          ...(Exit.isSuccess(exit)
            ? { size: exit.value.size, etag: exit.value.etag }
            : {}),
        }).pipe(Effect.asVoid)
      )
    );
    return objectFromInfo(options.storageId, info);
  });

  const remove = Effect.fn("FilesSDKDestination.delete")(function* (
    input: FilesSDKDeleteInput
  ) {
    const files = yield* configured;
    if (input.policy.kind === "owned-prefix") {
      const prefix = input.policy.prefix;
      if (!(prefix.endsWith("/") && input.key.startsWith(prefix))) {
        return yield* destinationError(
          "delete requires a nonempty owned folder prefix containing the key"
        );
      }
    }
    yield* files
      .delete(
        input.key,
        input.policy.kind === "exact"
          ? { condition: { etag: input.policy.etag } }
          : {}
      )
      .pipe(
        Effect.tapError((error) => diagnose("delete", input.key, error)),
        Effect.mapError((error) => destinationError("delete", error))
      );
    yield* record(changes.deleted, {
      storageId: options.storageId,
      key: input.key,
    });
  });

  return {
    changes,
    upload,
    transferFrom,
    copy,
    delete: remove,
    provide<E, R>(layer: Layer.Layer<Files, E, R>) {
      function provide<A>(
        effect: Effect.Effect<A, DestinationError, Files | Tracking>
      ) {
        return effect.pipe(
          Effect.provide(layer),
          Effect.mapError((error) =>
            error instanceof DestinationError
              ? error
              : destinationError("client layer", error)
          )
        );
      }
      return {
        changes,
        upload: (input: FilesSDKUploadInput) => provide(upload(input)),
        transferFrom: (input: FilesSDKTransferInput) =>
          provide(transferFrom(input)),
        copy: (input: FilesSDKCopyInput) => provide(copy(input)),
        delete: (input: FilesSDKDeleteInput) => provide(remove(input)),
      };
    },
  };
}

export const FilesSDKDestination = { make } as const;
