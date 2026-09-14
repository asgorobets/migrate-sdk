/** Shared validation for registry plans and direct runtime execution. */
export const runLimitValidationMessage = (input: {
  readonly limit?: number;
  readonly mode?: { readonly kind: string };
  readonly update?: boolean;
  readonly rollbackOrphans?: boolean;
  readonly targeted?: boolean;
}): string | undefined => {
  if (input.limit === undefined) {
    return;
  }
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    return "Run limit must be a positive safe integer";
  }
  if (
    (input.mode !== undefined && input.mode.kind !== "normal") ||
    input.update ||
    input.rollbackOrphans ||
    input.targeted
  ) {
    return "Run limit supports normal source scans only; it cannot combine with update, retry modes, source identity targets, or rollback orphans";
  }
  return;
};
