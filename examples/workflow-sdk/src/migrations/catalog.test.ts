import { describe, expect, it } from "vitest";
import { catalogRegistry } from "./catalog";

describe("catalogRegistry", () => {
  it("registers the two independently runnable dashboard migrations", () => {
    expect(
      catalogRegistry.list().map((entry) => ({
        group: entry.group,
        id: entry.id,
      }))
    ).toEqual([
      { group: "catalog", id: "authors" },
      { group: "catalog", id: "books" },
    ]);
    expect(
      catalogRegistry.list().find((entry) => entry.id === "books")?.dependencies
        .required
    ).toEqual(["authors"]);
  });
});
