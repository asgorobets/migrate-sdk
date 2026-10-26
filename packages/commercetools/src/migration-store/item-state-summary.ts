import { Effect, Schema } from "effect";
import { type MigrationDefinitionId, MigrationStoreError } from "migrate-sdk";
import type { CommercetoolsSdk } from "../sdk.ts";

const statuses = [
  { field: "migrated", status: "migrated" },
  { field: "failed", status: "failed" },
  { field: "skipped", status: "skipped" },
  { field: "needsUpdate", status: "needs-update" },
] as const;
type SummaryField = (typeof statuses)[number]["field"];
type StatusPage = (typeof statuses)[number] & { readonly after?: string };

const Page = Schema.Struct({
  count: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  results: Schema.Array(Schema.Struct({ key: Schema.NonEmptyString })),
});
const SummaryData = Schema.Struct({
  migrated: Schema.optional(Page),
  failed: Schema.optional(Page),
  skipped: Schema.optional(Page),
  needsUpdate: Schema.optional(Page),
  invalid: Schema.optional(Schema.Struct({ exists: Schema.Boolean })),
});

interface SummaryOptions {
  readonly container: string;
  readonly namespace: string;
  readonly pageSize: number;
}

const error = (message: string, cause?: unknown) =>
  new MigrationStoreError({
    message: `Unable to summarize migration item states: ${message}`,
    ...(cause === undefined ? {} : { cause }),
  });

// Keys remain stable across writes; modification timestamps can move a record
// ahead of a cursor even within the same status.
const statusSelection = ({ field }: StatusPage): string =>
  `${field}: customObjects(container: $container, where: $${field}Where, sort: ["key asc"], limit: $limit) { count results { key } }`;

const validatePage = Effect.fn(
  "CommercetoolsMigrationStore.validateSummaryPage"
)(function* (
  page: StatusPage,
  result: typeof Page.Type | undefined,
  limit: number
) {
  if (
    result === undefined ||
    result.count !== result.results.length ||
    result.count > limit
  ) {
    return yield* error(`invalid page for ${page.status}`);
  }
  let lastKey = page.after;
  for (const { key } of result.results) {
    if (lastKey !== undefined && key <= lastKey) {
      return yield* error(`non-advancing keyset page for ${page.status}`);
    }
    lastKey = key;
  }
  return { count: result.count, lastKey };
});

export const summarizeItemStates = Effect.fn(
  "CommercetoolsMigrationStore.summarizeItemStates"
)(function* (
  sdk: typeof CommercetoolsSdk.Service,
  options: SummaryOptions,
  definitionId: MigrationDefinitionId,
  formatVersion: number
) {
  const summary: Record<SummaryField, number> = {
    migrated: 0,
    failed: 0,
    skipped: 0,
    needsUpdate: 0,
  };
  const scope = [
    `value(namespace = ${JSON.stringify(options.namespace)})`,
    'value(recordKind = "migration-item-state")',
    `value(index(definitionId = ${JSON.stringify(definitionId)}))`,
  ].join(" and ");
  const validStatuses = statuses
    .map(({ status }) => {
      const literal = JSON.stringify(status);
      return `(value(index(status = ${literal})) and value(state(status = ${literal})))`;
    })
    .join(" or ");
  const invalidWhere = `${scope} and not (value(formatVersion = ${formatVersion}) and (${validStatuses}))`;
  let pending: readonly StatusPage[] = statuses;
  let checkMetadata = true;

  while (pending.length > 0) {
    const declarations = ["$container: String!", "$limit: Int!"];
    const selections: string[] = [];
    const variables: Record<string, string | number> = {
      container: options.container,
      limit: options.pageSize,
    };
    for (const page of pending) {
      declarations.push(`$${page.field}Where: String!`);
      selections.push(statusSelection(page));
      variables[`${page.field}Where`] = [
        scope,
        `value(index(status = ${JSON.stringify(page.status)}))`,
        ...(page.after === undefined
          ? []
          : [`key > ${JSON.stringify(page.after)}`]),
      ].join(" and ");
    }
    if (checkMetadata) {
      declarations.push("$invalidWhere: String!");
      selections.push(
        "invalid: customObjects(container: $container, where: $invalidWhere, limit: 0) { exists }"
      );
      variables.invalidWhere = invalidWhere;
    }
    const query = `query MigrationItemStateSummary(${declarations.join(", ")}) { ${selections.join(" ")} }`;
    const response = yield* sdk
      .request("graphql.summarizeMigrationItemStates", (project) =>
        project.graphql().post({ body: { query, variables } })
      )
      .pipe(Effect.mapError((cause) => error("GraphQL request failed", cause)));
    if (response.errors !== undefined && response.errors.length > 0) {
      return yield* error("GraphQL returned errors", response.errors);
    }
    const data = yield* Schema.decodeUnknownEffect(SummaryData)(
      response.data
    ).pipe(
      Effect.mapError((cause) => error("invalid GraphQL response", cause))
    );
    if (checkMetadata) {
      if (data.invalid === undefined) {
        return yield* error("missing metadata validation result");
      }
      if (data.invalid.exists) {
        return yield* error(
          "invalid status metadata or unsupported record format",
          {
            definitionId,
            namespace: options.namespace,
          }
        );
      }
      checkMetadata = false;
    }
    const next: StatusPage[] = [];
    for (const page of pending) {
      const result = yield* validatePage(
        page,
        data[page.field],
        options.pageSize
      );
      summary[page.field] += result.count;
      if (result.count === options.pageSize && result.lastKey !== undefined) {
        next.push({ ...page, after: result.lastKey });
      }
    }
    pending = next;
  }
  return summary;
});
