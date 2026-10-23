interface FormatMigrateErrorOptions {
  readonly includeName?: boolean;
}

const hasMessage = (value: unknown): value is { readonly message: string } =>
  typeof value === "object" &&
  value !== null &&
  "message" in value &&
  typeof value.message === "string";

const errorName = (value: { readonly message: string }): string | undefined => {
  if ("_tag" in value && typeof value._tag === "string") {
    return value._tag;
  }
  if ("name" in value && typeof value.name === "string") {
    return value.name;
  }
  return;
};

/** Render error messages and their causes without dumping stacks or payloads. */
export const formatMigrateError = (
  failure: unknown,
  options: FormatMigrateErrorOptions = {}
): string => {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  const messages = new Set<string>();
  let current = failure;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    let message: string | undefined;
    if (hasMessage(current)) {
      message = current.message;
    } else if (typeof current === "string") {
      message = current;
    }
    if (message !== undefined && !messages.has(message)) {
      messages.add(message);
      const name = hasMessage(current) ? errorName(current) : undefined;
      const named =
        name !== undefined && (depth > 0 || options.includeName === true)
          ? `${name}: ${message}`
          : message;
      lines.push(lines.length === 0 ? named : `Caused by: ${named}`);
    }
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      break;
    }
    current = current.cause;
  }
  return lines.length > 0
    ? lines.join("\n")
    : String(failure ?? "Migration run failed");
};
