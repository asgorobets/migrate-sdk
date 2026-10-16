# Files SDK folder migration

Copy a folder with the Migrate SDK CLI. Files SDK supplies the Source,
Destination, and Migration Store. Requires Node.js 22.19.0+ and pnpm.
The project uses published packages and can be copied out of the monorepo.

From this directory:

```sh
pnpm install
pnpm run setup
pnpm migrate list
pnpm migrate run folder-copy --plan
pnpm migrate run folder-copy --progress log
pnpm verify
```

Setup creates four source files, including a 1 MiB binary file. Copies keep their
relative paths:

```text
.data/source/                 → .data/destination/copied/
  hello.txt                      hello.txt
  catalog/products.json          catalog/products.json
  notes/readme.md                 notes/readme.md
  sample.bin                      sample.bin
.data/state/                   Saved migration progress
```

`pnpm verify` compares the source and destination bytes. The filesystem adapter
also writes `.meta.json` files to store metadata.

## The code

- `storage.ts` creates the three filesystem clients and the Migration Store.
- `folder-copy.ts` defines the Source, copying, tracking, and rollback with `MigrationDefinition.make`.
- `migrate.config.ts` registers that definition for the CLI.

Put your own files in `.data/source/`, or change the roots in `storage.ts`.
Paths resolve relative to that file. Each file is one Source Item; copying
finishes during its Process Pipeline execution, and a failed copy starts over
when retried.

For records inside JSON or CSV files, use `DocumentSource` with a Files SDK
Document Fetcher and a Document Parser. The [cookbook](https://migrate-sdk.dev/docs/cookbook/files-sdk)
shows that composition too.

## Rerun

```sh
pnpm migrate run folder-copy --progress log
pnpm migrate status folder-copy
```

The second run reports four unchanged files using progress in `.data/state/`.
After editing a source file:

```sh
pnpm migrate run folder-copy --rescan --progress log
pnpm verify
```

A rescan copies changed files and skips unchanged ones. `--update` forces all
migrated files to be processed again. Setup preserves existing files and state.

**Run one writer per namespace.** Files SDK locks are not atomic: two processes
can both acquire a lock and overwrite state. The required `locking: "advisory"`
option and the store's warning disclose this limit. It also applies to
cancellation updates. Locks do not expire; stop the original worker before
unlocking an abandoned lock.

## Roll back

```sh
pnpm migrate rollback folder-copy --plan
pnpm migrate rollback folder-copy --progress log
```

Rollback deletes files recorded in the saved journal. Reserve `copied/` for this
migration: its `owned-prefix` policy allows deletion from that folder without
an atomic ETag check. Copies may overwrite existing files; rollback cannot
restore their previous contents.

See the [CLI guide](https://migrate-sdk.dev/docs/operate/cli) for other commands.
