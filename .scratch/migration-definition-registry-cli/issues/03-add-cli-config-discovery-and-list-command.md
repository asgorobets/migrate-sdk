# Add CLI Config Discovery and List Command

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add the first CLI entrypoint path by loading a registry from an executable CLI config and rendering static registry discovery through `migrate list`. This slice proves config discovery, TypeScript config loading, default export validation, registry construction error rendering, and static catalog output without executing plans or runtime work.

## Acceptance criteria

- [x] The CLI exposes `defineMigrationCliConfig` from the CLI-facing public API.
- [x] `defineMigrationCliConfig` accepts a synchronous config object with a registry and optional execution adapter layer.
- [x] Config modules must provide the config as the default export.
- [x] Named config exports are out of scope and are rejected or ignored with a clear error.
- [x] Async config factories are rejected or not accepted by the public config helper.
- [x] `--config` uses exactly the supplied config file and resolves relative to the process current working directory.
- [x] Without `--config`, config discovery searches upward from the process current working directory.
- [x] The nearest config wins.
- [x] Discovery stops after checking a detectable workspace root when possible, otherwise at the filesystem root.
- [x] Discovery never searches downward into child packages.
- [x] Discovery checks `migrate.config.ts`, `migrate.config.mts`, `migrate.config.js`, and `migrate.config.mjs` in order.
- [x] Direct TypeScript config loading works for `migrate.config.ts` and `migrate.config.mts`.
- [x] JavaScript config loading works for `migrate.config.js` and `migrate.config.mjs`.
- [x] CommonJS, JSON, YAML, TOML, and INI config formats are out of scope for discovery.
- [x] Relative imports inside config files resolve from the config file location.
- [x] Known registry construction errors thrown while importing config are caught and rendered with all catalog issues.
- [x] Unknown config import failures are wrapped with config path and underlying cause.
- [x] `migrate list` renders static registry discovery metadata from `registry.list()`.
- [x] `migrate list` shows definition id, rollback availability, required dependencies, and optional dependencies.
- [x] `migrate list` marks unresolved optional dependencies without failing the command.
- [x] `migrate list` does not run planning, read stores, initialize plugin layers, or inspect runtime status.
- [x] `migrate list` does not include source or destination plugin columns in the first slice.
- [x] CLI tests cover exit codes and key rendered text without snapshotting the entire output.

## Blocked by

- [Add Static Migration Definition Registry](./01-add-static-migration-definition-registry.md)
