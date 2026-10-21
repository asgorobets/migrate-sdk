# Upstream TUI binary distribution patterns

Research date: 2026-10-16. This supplements the older
[`tui-binary-distribution.md`](./tui-binary-distribution.md); it records upstream
evidence, not this repository's implementation plan.

## Revisions and scope

Source inspection used these revisions, resolved with `git ls-remote`:

| Project | Revision inspected |
| --- | --- |
| OpenCode current `dev` | `c5681f4e1529645b5966dfe87f1bc7ddc24c56d5` |
| OpenCode stable `v1.19.2` | `7901b7d325c34852caa84fc2c325f3a08dd7a473` |
| Motel `main` | `31186212365f705ba539c4befbf34a9b9e4bbcfe` |
| Motel `v0.2.8` tag | `a8a875badb71cc304b2b1ae6b3ed62c8dc3a288e` |
| OpenTUI `v0.4.5` | `6c046e563c09cc7663edef036a396b9b799dc115` |

OpenCode's latest-release endpoint resolved to `v1.19.2`, whose release notes
explicitly separate the 1.x update line from OpenCode 2. Its current README
recommends `@opencode/cli`; the older package is `opencode-ai`. Consequently,
current `dev` packaging and stable 1.x packaging must not be conflated.
[Release notes](https://github.com/anomalyco/opencode/releases/tag/v1.19.2),
[current README](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/README.md).

## OpenCode: executable first, package managers as delivery channels

Both inspected build scripts describe **12 artifacts**:

| OS / libc | Architectures and CPU variants |
| --- | --- |
| Linux glibc | arm64, x64, x64-baseline |
| Linux musl | arm64, x64, x64-baseline |
| macOS | arm64, x64, x64-baseline |
| Windows | arm64, x64, x64-baseline |

Current `dev` installs OpenTUI and PTY native packages using
`bun install --os="*" --cpu="*"`, compiles minified ESM with bytecode, and fixes
`process.env.OPENTUI_LIBC` for Linux targets. Target package manifests constrain
`os` and `cpu`; this revision does **not** add a `libc` manifest field. It embeds
the web application archive and selected PTY executable through file imports,
and substitutes a target-specific Parcel watcher binding. `node-gyp` remains
external. It verifies native architecture and calls an artifact verifier after
building. Those are build checks, not proof of successful execution on every
target. The same script supports `BUN_COMPILE_RELEASE` to obtain an explicitly
selected Bun runtime executable.
[Current build script](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/packages/cli/script/build.ts).

The 1.x script explicitly includes its application TUI worker and OpenTUI's
Tree-sitter worker among compilation entry points. It installs native OpenTUI,
Parcel watcher, and FFF packages for all OS/CPU combinations. Its smoke test
runs `--version` only for the host OS/architecture and excludes ABI-specific
targets. Linux releases use `.tar.gz`; other platforms use `.zip`. The script
uploads archives to GitHub Releases. It enables runtime package/tsconfig
autoloading and disables Bunfig/dotenv autoloading.
[Stable build script](https://github.com/anomalyco/opencode/blob/v1.19.2/packages/opencode/script/build.ts).

The stable Node launcher finds the selected native package or cached executable,
spawns it with inherited terminal I/O, forwards `SIGINT`, `SIGTERM`, and `SIGHUP`,
and propagates termination. It selects libc and x64 CPU variants. That launcher
requires Node; the selected standalone executable contains its own Bun runtime.
[Stable launcher](https://github.com/anomalyco/opencode/blob/v1.19.2/packages/opencode/bin/opencode).

Current `dev` takes a different approach: the umbrella npm package has native
packages as `optionalDependencies`, and a Node postinstall replaces a placeholder
command with the selected executable. The placeholder explicitly fails when
installation scripts were disabled. All native package versions must match
before publication. Archives normalize permissions and timestamps.
[Current publisher](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/packages/cli/script/publish.ts).

Postinstall checks the resolved platform package version against the expected
version, hard-links or copies its binary, and executes `--version`. It can
install a missing target package in a temporary directory. Selection considers
libc, AVX2, and Windows ARM64 with emulated x64 Node. Its fallbacks are upstream
behavior, not evidence that cross-libc or emulated operation is guaranteed.
[Current postinstall](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/packages/cli/script/postinstall.mjs).

### Verification and signing

The current release workflow pins the Bun compiler/runtime to **1.4.2** for
the Bun CLI build. A macOS job signs CLI binaries with Developer ID, timestamp,
hardened runtime, and project entitlements, then verifies codesign. A Windows
job uses Azure artifact signing and requires valid Authenticode signatures.
These findings supersede the old study's statement that no macOS CLI signing
step was visible. No CLI notarization submission was found in this workflow;
that is a source-inspection limitation, not proof of its absence elsewhere.
[Release workflow](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/.github/workflows/publish.yml).

`verifyArtifact` scans output for forbidden simulation/font/rendering payloads;
`verifySimulationGraph` checks expected inputs and rejects a PNG-rendering
dependency. It does not launch the terminal UI.
[Verifier](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/packages/cli/script/verify-artifact.ts).
The update-artifact publisher records each uploaded file's SHA-256, URL, and
size. This alone does not establish a user-facing `SHA256SUMS` manifest.
[Artifact publisher](https://github.com/anomalyco/opencode/blob/c5681f4e1529645b5966dfe87f1bc7ddc24c56d5/script/update-artifact.ts).

## Motel: useful package validation, not a standalone-binary precedent

Motel's README explicitly says its npm command is a **Bun script** and requires
Bun on `PATH`, including after npm installation.
[README](https://github.com/kitlangton/motel/blob/31186212365f705ba539c4befbf34a9b9e4bbcfe/README.md).
At this revision the package is `@kitlangton/motel@0.2.8`; its commands point to
`src/motel.ts` and `src/mcp.ts`. It publishes source and `web/dist`; its build
hook builds the web UI. Its manifest requires Bun `>=1.3.0`, stricter than the
README's `v1.1` statement. There is no native executable compilation script in
this manifest.
[Manifest](https://github.com/kitlangton/motel/blob/31186212365f705ba539c4befbf34a9b9e4bbcfe/package.json).

Its release validation builds web assets, runs `npm pack`, checks required
tarball files, installs the tarball into a fresh consumer, and checks help,
SQLite-backed service queries, MCP startup, and runtime version consistency.
This is a strong model for validating what users actually install. It does not
exercise interactive TUI rendering or every OS.
[Validator](https://github.com/kitlangton/motel/blob/31186212365f705ba539c4befbf34a9b9e4bbcfe/scripts/validate-release.ts).
The Ubuntu publish workflow runs typecheck, tests, and that validator before
`npm publish --provenance`; its GitHub release command creates release notes
without uploading per-platform binary archives.
[Publish workflow](https://github.com/kitlangton/motel/blob/31186212365f705ba539c4befbf34a9b9e4bbcfe/.github/workflows/publish.yml).

## OpenTUI 0.4.5: bundled native dependencies and relocated acceptance

OpenTUI declares eight native optional packages: macOS, Windows, and Linux glibc
for arm64/x64, plus Linux musl arm64/x64. Its package uses conditional Bun/Node
runtime asset imports and exposes `node-assets`.
[Manifest](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/package.json).
The Bun asset loader selects the native library by OS, architecture, and
`OPENTUI_LIBC`; it also imports the parser worker as a file and Tree-sitter Wasm
as an embedded Wasm asset. Native asset presence and correct libc selection are
therefore release requirements beyond simply bundling application TypeScript.
[Bun asset loader](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/src/platform/runtime-assets.bun.ts).

The standalone acceptance script builds **both Bun executables and Node 26 SEA**.
It packs core/native packages, installs a clean consumer, compiles executables,
moves them, deletes the entire build directory, and runs from a fresh work
directory. The Bun application checks native buffers, Yoga identity/lifecycle,
and Tree-sitter Markdown highlighting. SEA embeds a manifest of assets and
extracts them beneath a hashed temporary root exposed through `OTUI_ASSET_ROOT`;
it uses `--experimental-ffi`. This is a framework acceptance test, not evidence
that this repository's full TUI already supports Node SEA or every target.
[Standalone acceptance script](https://github.com/anomalyco/opentui/blob/v0.4.5/packages/core/scripts/standalone-test.ts).

## Bun: current documentation differs materially from the pinned runtime

Bun's current executable documentation, displaying **1.4.3** when inspected,
lists eight OS/architecture/libc targets. It says x64 uses one Nehalem/SSE4.2
runtime with runtime-selected AVX2/AVX-512 paths, and `baseline`/`modern` suffixes
are compatibility aliases. It also documents embedded runtime/assets and
disabled-by-default package/tsconfig autoloading.
[Current executable documentation](https://bun.com/docs/bundler/executables).

**Do not apply that CPU claim to the repository's pinned Bun 1.3.14.** The
documentation at the exact `bun-v1.3.14` tag distinguishes Nehalem baseline from
Haswell modern, warns that modern requires AVX2, and recommends baseline for
older x64 CPUs. The older local research note's alias-equivalence statement
does not hold for that pinned documentation. A simple initial matrix can use
one explicitly baseline x64 artifact per OS/libc; optimized plus baseline
variants require an expanded matrix and selector. Whether baseline-only is the
right performance tradeoff should be measured. Upgrading Bun requires testing,
not merely changing target names.
[Bun 1.3.14 executable documentation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/bundler/executables.mdx#cross-compile-to-other-platforms).

## Limits and implications

- These findings inspect implementation and documented distribution. No upstream
  release binaries or npm tarballs were downloaded and executed in this study.
- OpenCode's binary-first delivery is the useful standalone reference; Motel's
  clean-consumer package check is the useful validation reference.
- Keep build-host cross-compilation separate from target-host execution tests.
  Native architecture checks, signatures, and `--version` each establish less
  than a relocated terminal interaction with the real application protocol.
- Bun compilation embeds Bun. It removes the user's separate Bun installation
  requirement; it does not remove Bun from the runtime implementation.
