# Standalone Migrate TUI binary strategy

Research date: 2026-10-16. Status: agreed direction; candidate build infrastructure
is implemented. See [build instructions and remaining release gates](../tui-binaries.md).
The public npm distribution has not switched to compiled binaries.

## Recommendation

Keep Bun as the build tool and embedded renderer runtime. Ship a compiled
`migrate-tui` executable for each supported platform, with the client-side Effect
and Migrate Protocol dependencies included. Users downloading these artifacts
should not need to install Bun or resolve JavaScript packages to use
`--server`. Keep local migration configuration, dependencies, and execution in
the project's Node Migrate Server, as required by
[ADR 0007](../adr/0007-server-boundary-for-local-and-remote-clients.md).

This removes the installation dependency on Bun without changing the renderer
implementation. Bun compilation bundles JavaScript and a runtime; it does not
turn all application code into statically linked machine code. OpenTUI still
has native libraries and platform requirements. See the
[Bun 1.3.14 executable documentation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/bundler/executables.mdx)
and the [upstream source study](./tui-binary-upstream-patterns.md).

The recommended rollout is direct-download binaries first, preserving the npm
package during the transition. Once binary local-mode parity is proven, decide
whether npm should select those same executables through platform-specific
optional packages. Replacing the TUI framework or moving customer migrations
to Bun is unnecessary for this goal.

## What the comparison establishes

| Reference | Observed approach | Application here |
| --- | --- | --- |
| OpenCode | Compiled Bun executables, target-native assets, release archives, and an npm launcher selecting platform packages | Follow its build/package/release separation and native-asset handling |
| Kit Langton's Motel | npm command points to a Bun TypeScript script; README requires Bun on PATH | Useful comparable TUI, but not evidence of standalone distribution |
| OpenTUI 0.4.5 | Platform-specific native dependencies and standalone tests | Verify renderer assets using our pinned release, beyond a version check |

Pinned revisions and first-party source links are in the
[upstream study](./tui-binary-upstream-patterns.md). OpenCode's current development
layout differs from the old study's URLs; recommendations should follow the
inspected source revision.

## Current repository: the remaining gaps

- [The npm launcher](../../packages/tui/bin/launcher.js) starts the package-pinned
  Bun 1.3.14 runtime and passes its own Node executable to the renderer. Users
  already do not need a global Bun installation.
- [The binary builder](../../packages/tui/scripts/build-binary.ts) accepts a Bun
  compile target, but leaves `effect` and `migrate-sdk` external. It writes every
  target into the same output directory and is not a release matrix.
- [The binary smoke test](../../packages/tui/test/binary-smoke.sh) relocates the
  executable and checks its version. It does not connect, render the dashboard,
  or execute a migration.
- [Local connection startup](../../packages/migrate-sdk/src/client/node/local-connection.ts)
  finds `local-server-entry.js` relative to `import.meta.url`. A fully bundled
  client cannot pass a path in Bun's virtual filesystem to an external Node
  process. Startup must resolve a real project-owned entry instead.
- That local connection deliberately requires an exact SDK version match and
  includes the SDK version in endpoint identity. Remote connections validate
  the Migrate Protocol version. Bundling dependencies does not remove these
  compatibility rules.
- [Package CI](../../.github/workflows/tui-package.yml) already covers five
  native OS/architecture combinations, with terminal tests on Unix. The
  [release workflow](../../.github/workflows/release.yml) publishes npm packages,
  but does not build, test, sign, or attach TUI binary archives.

The older [distribution study](./tui-binary-distribution.md) contains experiments
from before the Node server boundary. Its requirement that the renderer must
always externalize the SDK and Effect should not constrain the new binary
design: client and server now exchange serialized protocol messages. Dependency
identity still matters within the Node process loading customer configuration.

## Runtime contract

| Invocation | What the downloaded executable contains | What the environment supplies |
| --- | --- | --- |
| `migrate-tui --server <url>` | Renderer, Bun runtime, client Effect/RPC and protocol code, required native assets | A compatible Migrate Server and its connection credentials |
| `migrate-tui --config <path>` | The same client executable and local connection support | Node >=22.19.0, project configuration, project SDK/Effect and migration dependencies, a public Node server bootstrap |

For local mode, add a supported server bootstrap entry to the SDK package and
resolve it from the migration project. Do not make the binary depend on a
private `dist` path or a sibling file in the checkout. Resolve the entry using
project package resolution anchored at the selected configuration/project,
then spawn it with the selected real Node executable and project cwd.

Keep the existing exact local SDK version check for the initial release; report
the client and project versions clearly on mismatch. A binary that supports
multiple local SDK versions needs a separate change to endpoint identity,
handshake validation, and compatibility tests. Protocol-only compatibility for
remote servers already exists and should continue to work.

The bootstrap continues to own migration execution after the TUI exits. The
binary must preserve reconnect, stop, authorization, and draining behavior.
Keep bootstrap ownership in the SDK so the future supervisor and workers in
[ADR 0008](../adr/0008-local-source-generations.md) can replace its internals.

If “fully standalone” later includes local migrations on a computer without
Node, that is a second product requirement: distribute and maintain a Node
runtime as well. Moving the migrations into the Bun executable would change
the accepted runtime contract. It is not required to deliver standalone remote
operation or a single downloadable TUI client.

## Platform plan

Aim for eight logical targets. Publish support only after executing the artifact
in the corresponding environment.

| Artifact platform | Bun 1.3.14 compile target | Rollout |
| --- | --- | --- |
| macOS ARM64 | `bun-darwin-arm64` | First wave |
| macOS x64 | `bun-darwin-x64-baseline` | First wave |
| Linux glibc ARM64 | `bun-linux-arm64` | First wave |
| Linux glibc x64 | `bun-linux-x64-baseline` | First wave |
| Windows x64 | `bun-windows-x64-baseline` | First wave |
| Linux musl ARM64 | `bun-linux-arm64-musl` | After Alpine execution tests |
| Linux musl x64 | `bun-linux-x64-musl-baseline` | After Alpine execution tests |
| Windows ARM64 | `bun-windows-arm64` | After a suitable execution runner |

Use one baseline executable per x64 platform initially. Bun 1.3.14 distinguishes
baseline and modern CPU variants; the old note's statement that they are aliases
is incorrect for our pin. Verify OpenTUI's native CPU requirements too: selecting
Bun baseline alone does not prove the entire binary works on older CPUs.
[Pinned Bun target/CPU documentation.](https://github.com/oven-sh/bun/blob/bun-v1.3.14/docs/bundler/executables.mdx#supported-targets)

Define minimum OS/libc versions from the pinned dependencies and runtime tests;
do not describe the Linux artifacts as compatible with every Linux system.
Android, FreeBSD, and 32-bit platforms are outside this matrix.

## Build and release shape

1. Add a validated target manifest with artifact name, Bun target, native
   OpenTUI package/libc, execution environment, and signing requirements. Give
   each output its own directory, such as `dist/binary/<target>/migrate-tui`.
2. Build release binaries with client dependencies bundled. Keep external
   customer modules exclusively in the Node server. Disable renderer autoload
   of project Bun/TypeScript/package configuration unless a tested client
   feature needs it. Preserve configuration loading in the Node host.
3. Start with native platform jobs using the existing five-platform CI matrix.
   This reduces cross-compilation asset-selection risk. For cross-compilation,
   deliberately provision target-native optional packages in an isolated build
   workspace and bind the target libc. A host-only install is insufficient.
4. Verify every used native library, Yoga/FFI asset, and worker can be loaded
   after relocation. Add worker entrypoints explicitly where required by the
   pinned OpenTUI/Bun build. Test any future parser feature's assets as well.
5. Embed the package version and record the immutable source revision, Bun
   version, OpenTUI version, target, and build settings in release metadata.
   Keep Bun/OpenTUI upgrades separate from the initial packaging work.
6. Sign and verify macOS/Windows production artifacts in their native jobs;
   define the macOS notarization gate. Test the resulting artifacts, archive
   them, then hash the final archives into `SHA256SUMS`.
7. Use versioned `.tar.gz` archives for Unix and `.zip` for Windows, for example
   `migrate-tui-0.14.1-linux-x64-glibc.tar.gz`. Include licenses/notices. Publish
   against the same immutable commit and version as the Changesets release;
   keep a release draft until all promised artifacts pass.
8. Add a checksum-verifying installer and Homebrew after direct archives work.
   Reuse the same artifacts for every channel. If npm later selects compiled
   binaries, retain a launcher path that works with lifecycle scripts disabled.
   Preserve the existing programmatic JavaScript API and its peer dependency
   contract when considering that package change.

OpenCode's build, launcher, and signing implementations, and OpenTUI's
standalone asset tests, are linked in the
[source study](./tui-binary-upstream-patterns.md). These are release engineering
patterns to adapt to our server ownership and compatibility requirements.

## Implementation milestones and completion criteria

**1. Standalone remote client.** Add a build mode with bundled client
dependencies. Verify a relocated executable from a clean directory with no
Node/Bun on PATH and no project packages. Connect to an authenticated test Migrate
Server, render its registry/status, perform an operation, and exit cleanly.
Exercise missing/invalid credentials, connection failure, and protocol mismatch.

**2. Local-mode parity.** Add the public project-owned Node bootstrap and its
resolver; preserve exact local SDK compatibility. Install a fixture project
outside the checkout and use a relocated binary to load TypeScript config and a
real dependency, run a migration, reconnect while work continues after quitting,
and stop it cooperatively. Verify missing Node, missing SDK, version mismatch,
and config errors. Test a Node-specific dependency to catch accidental Bun
execution. This milestone is necessary before replacing the existing local
installation recommendation.

**3. Five-platform release.** Run connection and renderer checks on each first
wave platform, covering native Windows terminal behavior as well as Unix PTYs.
Sign, archive, checksum, and attach artifacts to a draft release. Run acceptance
tests on the distributable bytes after signing. Document the tested OS/CPU floor
and local versus remote prerequisites.

**4. Remaining targets and convenience channels.** Add musl and Windows ARM64
once execution tests exist; then installer/Homebrew and, if justified, npm
platform packages. Compilation success alone does not establish support.

## Experiments performed during this research

On macOS ARM64, using the installed Bun **1.3.14** and OpenTUI **0.4.5**:

- Compiled the current TUI entrypoint with **no external packages**, using ESM,
  minification, linked sourcemaps, and disabled config autoloading. The executable
  measured **76,143,842 bytes (72.62 MiB)**.
- Ran `--version` and `--help` from `/private/tmp`, with `env -i
  PATH=/usr/bin:/bin`. Both succeeded without project dependencies or Node/Bun
  on PATH. An unavailable remote endpoint produced the expected connection
  error rather than a missing-package error.
- Compiled a separate OpenTUI native-renderer smoke executable. Under the same
  clean environment, it initialized a test renderer, rendered once, and shut
  down successfully.

Temporary artifacts are under
`/private/tmp/migrate-tui-binary-research-20261016/`. No application or release
code was changed. These experiments establish host startup and native-renderer
feasibility; they do **not** establish a successful full remote session, binary
local-mode parity, other-platform execution, signing, or release readiness.
