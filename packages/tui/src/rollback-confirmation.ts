import type { MigratePreparedOperation } from "migrate-sdk/protocol";

export const rollbackConfirmation = (
  operation: MigratePreparedOperation
): { readonly paragraphs: readonly string[]; readonly buttonLabel: string } => {
  let description = "Rollback migrations with dependencies";
  if (operation.sourceIdentities !== undefined) {
    const count = operation.sourceIdentities.length;
    description =
      count === 1
        ? "Rollback 1 selected entry"
        : `Rollback ${count} selected entries`;
  } else if (!operation.plan.withDependencies) {
    description =
      operation.plan.executionDefinitionIds.length === 1
        ? "Rollback selected migration only"
        : "Rollback selected migrations only";
  }

  const paragraphs = [description];
  if (operation.plan.force === true) {
    paragraphs.push("Dependent records remain; references may break.");
  }

  return {
    buttonLabel: "y Rollback selected",
    paragraphs,
  };
};
