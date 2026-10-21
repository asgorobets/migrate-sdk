# Migrate SDK getting started

Run a migration with Node, Effect, and real filesystem writes. Two author records
become JSON files in `authors/`; migration progress is saved in `.migrate/`.

This folder is the source for the getting-started guide. Copy the entire folder
to use it independently of the monorepo. Dependencies come from npm.

## Run locally

Use Node **22.19 or newer**:

```sh
npm ci
npm start
```

Open `authors/author-1.json` to see the result. Then try:

1. Run `npm start` again. Both records are unchanged, so nothing is rewritten.
2. Change Ada's `lastName` in `source.ts` from `Morgan` to `Lovelace`.
3. Run `npm start`. Only Ada's file changes.
4. Run `npm run update` to reprocess both records, even when unchanged.
5. Run `npm run rollback` to remove the author files using their tracked paths.
6. Run `npm start` to migrate both records again.

Keep `.migrate/` between runs so the SDK can remember progress and roll back.
Rollback deletes the current files; it does not restore previous contents.

## Verify the whole example

```sh
npm test
```

This checks first migration, unchanged records, a source change, explicit updates,
rollback, and migration after rollback in separate Node processes. It uses a
temporary copy and leaves your source records and migration progress alone.

## Open from GitHub in StackBlitz

Once this folder is available on the chosen public branch, open:

```text
https://stackblitz.com/fork/github/asgorobets/migrate-sdk/tree/BRANCH/apps/docs/content/examples/getting-started?view=editor&openFile=README.md&startScript=start
```

Replace `BRANCH` with the published branch or tag. StackBlitz imports this folder,
installs its dependencies, and runs `npm start`. A fresh launch from the GitHub
link uses the selected branch's contents; a saved personal fork is independent.

StackBlitz's filesystem belongs to the browser environment. Keep the environment
open while experimenting with saved progress; do not rely on it as durable
storage across browser sessions.

The lockfile pins the dependency tree. The override keeps Effect's shared Node
platform package on the same release candidate as `effect` and
`@effect/platform-node`.
