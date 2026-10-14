export const definitionSteps = [
  {
    id: "source",
    label: "Source",
    title: "Emit typed source items.",
    description:
      "A Source declares the payload schema, stable identity, and version of each item it emits.",
    previewFrom: "const AuthorRow =",
    previewUntil: "const AuthorInput =",
    contextFrom: "const csvOptions =",
    contextUntil: "const AuthorInput =",
  },
  {
    id: "process",
    label: "Process",
    title: "Call a typed destination helper.",
    description:
      "Processing receives decoded source data. The destination helper accepts and validates its own schema-defined input.",
    previewFrom: "const AuthorInput =",
    previewUntil: "const authorTracking =",
    contextFrom: "const processAuthor:",
    contextUntil: "const rollbackAuthor:",
  },
  {
    id: "track",
    label: "Track",
    title: "Preserve destination results.",
    description:
      "A Tracking Record Contract defines the durable result each successful item must preserve.",
    previewFrom: "const processAuthor:",
    previewUntil: "const rollbackAuthor:",
    contextFrom: "const authorTracking =",
    contextUntil: "const deleteAuthor =",
  },
  {
    id: "rollback",
    label: "Rollback",
    title: "Compensate from saved state.",
    description:
      "A Rollback Pipeline uses saved tracking evidence to undo destination work without reading the source again.",
    previewFrom: "const rollbackAuthor:",
    previewUntil: "export const authors =",
    contextFrom: "const deleteAuthor =",
    contextUntil: "type AuthorProcess =",
  },
  {
    id: "compose",
    label: "Definition",
    title: "Compose your capabilities.",
    description:
      "A Migration Definition connects the Source, processing, tracking, rollback, and Migration Store.",
    previewFrom: "export const authors =",
    previewUntil: "// Save this file",
    contextFrom: "// Save this file",
    contextUntil: "",
  },
] as const;
