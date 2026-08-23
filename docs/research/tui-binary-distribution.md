# TUI binary distribution

Research date: 2026-08-22

## Conclusion

The npm package should ship a Node launcher that starts the compiled JavaScript
TUI with the pinned runtime from the official `bun` package. This keeps
`migrate-sdk` and `effect` as ordinary peer dependencies resolved from the
migration project, which is the defining requirement: the TUI is an interface
over the locally installed SDK, not a second SDK distribution. Bun and OpenTUI
already use platform-specific optional dependencies, so npm can reuse their
native-package selection instead of publishing another Migrate-specific binary
matrix.

The launcher is implemented in `packages/tui/bin`. It answers `--version`
without starting Bun, forwards process signals to the child runtime, reports
unsupported platforms, and falls back to Bun's platform package when lifecycle
scripts were disabled and the top-level executable was not copied into place.

`bun build --compile` remains viable for a later direct-download or Homebrew
artifact. Such an executable must not embed `migrate-sdk` or `effect`; both stay
external runtime peers. OpenTUI itself has an official standalone acceptance
test covering its native renderer, Yoga, and Tree-sitter integration, and a
local compile of this repository's TUI rendered successfully against the real
TypeScript migration config.
[See OpenTUI's standalone test.](https://github.com/anomalyco/opentui/blob/main/packages/core/scripts/standalone-test.ts)

The direct-binary track is a release pipeline, not one build command. Its
recommended shape is:

- GitHub Releases are the canonical source of per-platform UI archives and a
  `SHA256SUMS` file;
- npm remains the primary distribution channel and uses the packaged Bun
  runtime plus local SDK;
- Homebrew follows once release automation is stable;
- macOS and Windows artifacts are signed in native-OS jobs before publication;
- each supported artifact is exercised on its target OS with a real external
  `migrate.config.ts`, not merely compiled.

Start with macOS arm64/x64, Linux glibc arm64/x64, and Windows x64. Bun and
OpenTUI also support Linux musl arm64/x64 and Windows arm64, so those are good
second-wave targets after there are runners that can execute their smoke tests.
Do not add separate `-baseline` x64 packages initially: Bun's current target
documentation says the baseline and modern suffixes resolve to the same x64
binary.
[Bun documents the complete executable target matrix.](https://bun.sh/docs/bundler/executables#cross-compile-to-other-platforms)

## Feasibility in this repository

The current entry point compiled on macOS arm64 with Bun 1.3.14 into an
approximately 74 MB Mach-O executable. `--help` worked and the OpenTUI renderer
started. A minimal compiled OpenTUI renderer also initialized and shut down
successfully, confirming that the released native library can be extracted and
loaded by a host-platform executable.

The compiled shell initially embedded its own copies of `migrate-sdk` and
`effect`, while an external config independently imported the workspace copies.
A real migration happened to work across that boundary, but that is not a safe
compatibility contract. The production build now externalizes both packages.
With Bun's package and tsconfig autoloading enabled, the relocated executable
resolved the migration project's packages and completed a real migration under
Pilotty. For a direct binary, the launcher or installer must invoke it with the
consumer project's working directory, where its external runtime peers can be
resolved.

The first full application build could not load the repository's external
`examples/migrate.config.ts`: code imported after startup could not resolve its
`effect` dependency. Rebuilding with both of these compile options fixed the
real application:

```ts
compile: {
  autoloadTsconfig: true,
  autoloadPackageJson: true
}
```

The relocated binary then loaded the external TypeScript config, rendered the
migration status view, executed a migration using the project's SDK, handled
`q`, and exited successfully. Bun intentionally turns these autoload behaviors
off for compiled executables unless they are enabled.
[See Bun's runtime-behavior options.](https://bun.sh/docs/bundler/executables#runtime-behavior)

These two options and the external package list are therefore part of the TUI's
compatibility contract, not optimizations. Release CI should compile the
binary, move it outside the checkout/build directory, run it from a fixture
project with its own compatible `effect` and `migrate-sdk` installation, load
that project's config, execute a migration, and exit through the UI. That test
protects the feature that matters most: running consumer-authored migrations
with the consumer's SDK version.

Use `--minify` and an embedded or linked source map for production builds, as
Bun recommends. Bytecode can be evaluated later; it is not required for a
correct executable.
[See Bun's production executable guidance.](https://bun.sh/docs/bundler/executables#minification)

## Native dependencies and assets

`@opentui/core` is not platform-neutral JavaScript. Its official package
declares optional native packages for Darwin x64/arm64, Linux glibc x64/arm64,
Linux musl x64/arm64, and Windows x64/arm64.
[See `@opentui/core`'s package manifest.](https://github.com/anomalyco/opentui/blob/main/packages/core/package.json)

OpenTUI's Bun runtime asset module also embeds the parser worker and
Tree-sitter Wasm and selects the native package from `process.platform`,
`process.arch`, and `OPENTUI_LIBC`.
[See OpenTUI's Bun asset loader.](https://github.com/anomalyco/opentui/blob/main/packages/core/src/platform/runtime-assets.bun.ts)

Consequently, cross-compiling requires all target-specific optional packages
to be present in the build workspace. A local `bun-linux-x64` compile failed
when only the host's `@opentui/core-darwin-arm64` package was installed. OpenCode
solves this before its build matrix by installing OpenTUI with all operating
systems and CPUs enabled, then defines `OPENTUI_LIBC` per Linux artifact.
[See OpenCode's current build script.](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/build.ts)

Follow that pattern in a pinned release build rather than relying on the host
package manager's default optional-dependency pruning. Also retain a relocated
binary test if the UI later adds code, diff, or Markdown rendering: OpenCode
explicitly embeds worker entry points used by its richer UI, while OpenTUI's
own standalone test is the minimum proof for the framework's packaged assets.

Bun can embed files imported with `with { type: "file" }` and makes them
available through its virtual filesystem. Worker entry points that an
application owns must be included in the build explicitly.
[See Bun's asset and worker guidance.](https://bun.sh/docs/bundler/executables#embed-assets-and-files)

## Why npm differs from OpenCode and ghui

OpenCode and ghui are useful implementation references rather than templates to
copy unchanged. Their compiled applications own the backend code they execute;
this TUI must share a dependency identity with user-authored migration config.
For npm, running the JavaScript application with the consumer's peer dependency
graph is therefore safer than embedding that graph into a standalone binary.

For the optional direct-binary channel, OpenCode's release shape remains useful:

1. Its build script produces named executables for Darwin, Linux glibc, Linux
   musl, and Windows across arm64/x64, creates `.zip` or `.tar.gz` archives, and
   creates small npm packages constrained by `os`, `cpu`, and, for Linux,
   `libc`.
2. Its umbrella npm package lists those packages as `optionalDependencies`.
   The launcher resolves the matching package and spawns its executable while
   forwarding termination signals. A postinstall script additionally selects
   and installs/copies the matching binary and verifies it with `--version`.
3. The publish workflow uploads archives to GitHub Releases and publishes the
   platform packages plus the umbrella package to npm.
4. Its publishing code hashes release archives for generated Homebrew and AUR
   metadata.

The relevant primary sources are OpenCode's
[build script](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/build.ts),
[publisher](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/publish.ts),
[postinstall selector](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/postinstall.mjs),
[launcher](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/bin/opencode),
and [publish workflow](https://github.com/anomalyco/opencode/blob/dev/.github/workflows/publish.yml).
Its official documentation also offers the install script, npm/Bun/pnpm/yarn,
Homebrew, Arch, Chocolatey, Scoop, and direct release downloads.
[See OpenCode's install documentation.](https://opencode.ai/docs/#install)

For this TUI, do not duplicate that platform-package model on npm unless the
packaged-runtime approach proves inadequate. The Node launcher already forwards
`SIGINT`, `SIGTERM`, and `SIGHUP`, and it does not depend exclusively on
postinstall because lifecycle scripts can be disabled. A future direct binary
still needs a stable `--version` command so installers and release smoke tests
can verify the selected artifact.

## Signing, notarization, and checksums

Bun notes that compiled macOS executables are ad-hoc signed by the linker and
documents re-signing them with a Developer ID identity plus Bun-compatible
entitlements for JIT, unsigned executable memory, and library validation. It
also documents verifying the result with `codesign -vvv`.
[See Bun's macOS code-signing instructions.](https://bun.sh/docs/bundler/executables#code-signing-on-macos)

The locally compiled TUI was only ad-hoc signed and had no Team Identifier. It
is not a production-signed artifact. The release design should therefore:

- pass each Darwin executable through a macOS signing job, verify it, package
  it only after signing, and treat notarization as a separate release gate;
- pass each Windows executable through a native Windows signing job and verify
  the Authenticode status before repackaging;
- calculate hashes after signing and archive creation, then publish a single
  machine-readable `SHA256SUMS` asset beside the archives.

OpenCode provides a concrete Windows precedent: its current workflow uses
Azure Trusted Signing, verifies the signature, and replaces the unsigned
Windows archive. The same workflow contains Apple credential handling for its
desktop artifacts, but no corresponding macOS CLI signing/notarization step is
visible. That absence is an inference from the workflow, so OpenCode should not
be treated as evidence that an unsigned or unnotarized macOS CLI is production
ready.
[See OpenCode's publish workflow.](https://github.com/anomalyco/opencode/blob/dev/.github/workflows/publish.yml)

OpenCode's publisher calculates SHA-256 hashes for package-manager metadata;
this project should additionally publish the checksum manifest directly so a
standalone installer and users can verify the same immutable archives.
[See OpenCode's checksum generation.](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/script/publish.ts)

## npm release gates

The npm package is ready for release when:

- its Node launcher, compiled JavaScript entry point, and runtime dependency are
  present in the packed tarball;
- the launcher is tested with lifecycle scripts enabled and disabled;
- the packed package is installed in a fixture project and Pilotty runs a real
  migration using that fixture's `migrate-sdk` and `effect` dependencies;
- supported-platform CI covers macOS and Linux arm64/x64 plus Windows x64;
- the TUI is in the SDK's Changesets fixed group, so every published TUI version
  matches the SDK release it wraps, while its peer range rejects incompatible
  SDK minors.

## Direct-binary release gates

The binary distribution is ready for release when all of the following are
automated:

- Bun and OpenTUI versions are pinned and every target's native optional
  package is deliberately installed;
- the build preserves package/tsconfig autoloading and records a version;
- every advertised target runs `--version` and a relocated external-config
  status-screen test on that target OS;
- Pilotty exercises startup, navigation, cancellation, and clean exit for the
  primary platforms;
- archives use deterministic names and are accompanied by `SHA256SUMS`;
- Darwin and Windows artifacts are signed and verified, and the macOS
  notarization decision is explicit rather than implied;
- the direct installer reports an actionable unsupported-platform error.

This keeps the initial package focused while avoiding the two risks that a
local host-only build hides: dynamic consumer config resolution and
target-specific OpenTUI native libraries.
