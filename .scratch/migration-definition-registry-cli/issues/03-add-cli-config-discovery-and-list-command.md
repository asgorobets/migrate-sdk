# Add CLI Config Discovery and List Command

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add the first CLI entrypoint path by loading a registry from an executable CLI config and rendering static registry discovery through `migrate list`. This slice proves config discovery, TypeScript config loading, default export validation, registry construction error rendering, and static catalog output without executing plans or runtime work.

## Acceptance criteria

- [ ] The CLI exposes `defineMigrationCliConfig` from the CLI-facing public API.
- [ ] `defineMigrationCliConfig` accepts a synchronous registry-only config object.
- [ ] Config modules must provide the config as the default export.
- [ ] Named config exports are out of scope and are rejected or ignored with a clear error.
- [ ] Async config factories are rejected or not accepted by the public config helper.
- [ ] `--config` uses exactly the supplied config file and resolves relative to the process current working directory.
- [ ] Without `--config`, config discovery searches upward from the process current working directory.
- [ ] The nearest config wins.
- [ ] Discovery stops after checking a detectable workspace root when possible, otherwise at the filesystem root.
- [ ] Discovery never searches downward into child packages.
- [ ] Discovery checks `migrate.config.ts`, `migrate.config.mts`, `migrate.config.js`, and `migrate.config.mjs` in order.
- [ ] Direct TypeScript config loading works for `migrate.config.ts` and `migrate.config.mts`.
- [ ] JavaScript config loading works for `migrate.config.js` and `migrate.config.mjs`.
- [ ] CommonJS, JSON, YAML, TOML, and INI config formats are out of scope for discovery.
- [ ] Relative imports inside config files resolve from the config file location.
- [ ] Known registry construction errors thrown while importing config are caught and rendered with all catalog issues.
- [ ] Unknown config import failures are wrapped with config path and underlying cause.
- [ ] `migrate list` renders static registry discovery metadata from `registry.list()`.
- [ ] `migrate list` shows definition id, rollback availability, required dependencies, and optional dependencies.
- [ ] `migrate list` marks unresolved optional dependencies without failing the command.
- [ ] `migrate list` does not run planning, read stores, initialize plugin layers, or inspect runtime status.
- [ ] `migrate list` does not include source or destination plugin columns in the first slice.
- [ ] CLI tests cover exit codes and key rendered text without snapshotting the entire output.

## Blocked by

- [Add Static Migration Definition Registry](./01-add-static-migration-definition-registry.md)
