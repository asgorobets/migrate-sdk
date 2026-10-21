import { NodeServices } from "@effect/platform-node";
import { Schema } from "effect";
import { CsvIdentity, CsvSource } from "migrate-sdk/sources/csv";

const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  first_name: Schema.NonEmptyString,
  last_name: Schema.NonEmptyString,
});

export const authorSource = CsvSource.make({
  path: "./authors.csv",
  platform: NodeServices.layer,
  sourceSchema: AuthorRow,
  identity: CsvIdentity.column({ column: "id", id: "author-id@v1" }),
  version: { kind: "row-hash" },
  dialect: { kind: "standard" },
  headers: { kind: "from-row", rowIndex: 0 },
  emptyRows: { kind: "skip" },
});
