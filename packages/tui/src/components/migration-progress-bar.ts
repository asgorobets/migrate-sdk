import type { MigrateSourceItemTotal } from "migrate-sdk/protocol";

export interface MigrationProgressCounts {
  readonly failed: number;
  readonly migrated: number;
  readonly needsUpdate: number;
  readonly skipped: number;
}

export interface MigrationProgressBarModel {
  readonly label: string;
  readonly remaining: number;
  readonly segments: readonly {
    readonly count: number;
    readonly kind: "failed" | "migrated" | "needs-update" | "skipped";
  }[];
}

const countProcessedItems = (counts: MigrationProgressCounts): number =>
  counts.migrated + counts.failed + counts.skipped + counts.needsUpdate;

export const aggregateSourceItemTotals = (
  totals: readonly (MigrateSourceItemTotal | undefined)[]
): MigrateSourceItemTotal | undefined => {
  if (totals.length === 0 || totals.some((total) => total === undefined)) {
    return;
  }

  if (totals.length === 1) {
    return totals[0];
  }

  const availableTotals = totals.filter(
    (total): total is MigrateSourceItemTotal => total !== undefined
  );

  const countableTotals = availableTotals.filter(
    (
      total
    ): total is Exclude<MigrateSourceItemTotal, { readonly kind: "unknown" }> =>
      total.kind !== "unknown"
  );

  if (countableTotals.length !== availableTotals.length) {
    return;
  }

  const count = countableTotals.reduce(
    (sum, total) =>
      sum + (total.kind === "known" ? total.count : total.minimum),
    0
  );

  return countableTotals.every((total) => total.kind === "known")
    ? { count, kind: "known" }
    : { kind: "lower-bound", minimum: count, reason: "capped" };
};

export const migrationProgressBarModel = (
  counts: MigrationProgressCounts,
  sourceItemTotal: MigrateSourceItemTotal | undefined
): MigrationProgressBarModel => {
  const processed = countProcessedItems(counts);
  const overflow =
    sourceItemTotal?.kind === "known"
      ? Math.max(0, processed - sourceItemTotal.count)
      : 0;
  const candidates = [
    { count: counts.migrated, kind: "migrated" as const },
    { count: counts.failed, kind: "failed" as const },
    { count: counts.skipped, kind: "skipped" as const },
    { count: counts.needsUpdate, kind: "needs-update" as const },
  ];
  const label = (() => {
    if (sourceItemTotal?.kind === "known") {
      if (overflow > 0) {
        return `${processed} tracked · ${sourceItemTotal.count} source · +${overflow} outside source`;
      }

      const percentage =
        sourceItemTotal.count === 0
          ? 100
          : Math.min(
              100,
              Math.round((processed / sourceItemTotal.count) * 100)
            );
      return `${processed} / ${sourceItemTotal.count} · ${percentage}%`;
    }
    if (sourceItemTotal?.kind === "lower-bound") {
      return `${processed} / ${sourceItemTotal.minimum}+`;
    }

    return `${processed} processed`;
  })();

  if (sourceItemTotal?.kind !== "known") {
    return { label, remaining: 1, segments: [] };
  }

  if (sourceItemTotal.count === 0 && processed === 0) {
    return {
      label,
      remaining: 1,
      segments: [],
    };
  }

  const segments = candidates.filter((segment) => segment.count > 0);

  return {
    label,
    remaining: Math.max(0, sourceItemTotal.count - processed),
    segments,
  };
};
