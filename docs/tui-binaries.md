# Building Migrate TUI binaries

The binary pipeline compiles the TUI with pinned Bun and OpenTUI, bundles its
client dependencies, and stages platform npm packages and direct-download
archives. From 0.16.0, the release workflow publishes those platform packages
before publishing the native launcher to npm. Host-only builds remain private
candidates. Public executables are currently unsigned; npm releases use GitHub
OIDC provenance, and GitHub release archives include SHA-256 checksums.

## Build and verify the host platform

Use the repository's pinned pnpm version and install the workspace dependencies:

```sh
pnpm install --frozen-lockfile
pnpm turbo run test:binary --filter=@migrate-sdk/tui
```

Turbo builds the SDK and TUI JavaScript first, then compiles, packages, and tests
the native executable. The binary tasks bypass the shared cache because their
outputs depend on the host OS/architecture and embedded runtime. Run them through
this pipeline rather than alongside a separate build that cleans `dist`.

Bun is the build-time compiler and comes from the workspace's pinned dependency.
Maintainers do not need a global Bun install. Consumers of the compiled output
do not install Bun, compile the TUI, or approve Bun/esbuild install scripts.

On Windows, keep Bun's compiler cache on the same drive as the checkout. Pinned
Bun 1.3.14 can fail to move an extracted target executable across drives and
report an incomplete download. CI sets `BUN_INSTALL_CACHE_DIR` inside the build
output; Turbo passes it to compilation and the compiled-client smoke test.
For a local PowerShell build from the repository root:

```powershell
$env:BUN_INSTALL_CACHE_DIR = Join-Path (Get-Location) "packages/tui/dist/.bun-cache"
pnpm turbo run test:binary --filter=@migrate-sdk/tui
```

The acceptance test verifies checksums, relocates the executable, runs help and
version with no Node or Bun on PATH, installs the generated npm tarballs with
lifecycle scripts disabled, launches a fresh registry-backed `pnpm dlx` with
strict dependency build checks and scripts enabled, and executes a migration through a compiled client
and the project's Node server. Unix also exercises the full dashboard, migration
execution, and quit through both the relocated executable and installed launcher
in a real PTY. Windows runs the compiled RPC client test; interactive Windows
terminal coverage remains a release gate.

Outputs under `packages/tui/dist/`:

| Path | Contents |
| --- | --- |
| `binary/<target>/` | Executable and build metadata: version, revision, compiler, native framework, size, SHA-256 |
| `distribution/packages/<target>/` | Platform npm package containing the executable |
| `distribution/packages/tui/` | Staged umbrella package with the native launcher and exact optional package versions |
| `distribution/tarballs/` | Installable npm tarballs |
| `distribution/archives/` | Unix tar.gz and Windows zip archives |
| `distribution/SHA256SUMS` | Checksums of the final archives and npm tarballs |
| `distribution/distribution.json` | Included targets/version/revision, release readiness, and signing status |

Each generated umbrella package references **only the targets supplied to that
packaging run**. Host-only candidates are private and have `releaseReady: false`.
The `package:release` command requires all five tested targets, removes private
markers, and records `releaseReady: true`. All inputs must match the current package,
Bun, and OpenTUI versions and source revision. Packaging rejects modified bytes
and executables whose file headers disagree with the target architecture.

## Install a compiled candidate

For native npm releases (0.16.0 onward), install the TUI as an exact project dev
dependency, or use `pnpm dlx @migrate-sdk/tui@<version> --server <url>`. npm/pnpm
select the platform executable through optional dependencies. No install scripts
or postinstall downloads are used. Releases through 0.15.x retain the Bun
package layout and need `pnpm --config.ignore-scripts=true dlx` when strict build
checks are enabled.

The instructions below also support testing unpublished local build candidates.

### Install in a migration project

After the host build above, run these commands from the repository root in the
same shell. Pack the matching SDK because local candidates need this checkout's
public Node server entry as well as an exact SDK version match:

```sh
MIGRATE_BINARY_DIST="$(pwd)/packages/tui/dist/distribution"
MIGRATE_BINARY_VERSION="$(node -p "require('./packages/tui/package.json').version")"
pnpm --filter migrate-sdk pack --pack-destination "$MIGRATE_BINARY_DIST/tarballs"
```

Then change to your migration project and install the candidate SDK, umbrella
package, and native package. This example uses macOS ARM64; replace
`darwin-arm64` with your built target from `distribution.json`:

```sh
cd /absolute/path/to/your/migration-project
pnpm add --save-exact \
  "$MIGRATE_BINARY_DIST/tarballs/migrate-sdk-$MIGRATE_BINARY_VERSION.tgz"
pnpm add --save-dev --ignore-scripts \
  "$MIGRATE_BINARY_DIST/tarballs/migrate-sdk-tui-$MIGRATE_BINARY_VERSION.tgz" \
  "$MIGRATE_BINARY_DIST/tarballs/migrate-sdk-tui-darwin-arm64-$MIGRATE_BINARY_VERSION.tgz"
pnpm exec migrate-tui --config ./migrate.config.ts
```

Keep the project's Effect dependencies aligned with the candidate SDK's
`package.json`. Both TUI tarballs must have the same version. The explicit native
package is needed for an unpublished candidate; released native distributions
select it automatically through optional dependencies. The install works with lifecycle scripts disabled and needs no
postinstall download or separate Bun runtime.

Add a package script so each project opens the TUI recorded in its lockfile:

```json
{
  "scripts": {
    "tui": "migrate-tui"
  }
}
```

Use `pnpm run tui` or `npm run tui`. Local migrations still require Node
`>=22.19.0` and the matching project SDK. For a released version, replace the tarball installs with an exact
project dependency:

```sh
pnpm add --save-dev --save-exact "@migrate-sdk/tui@$MIGRATE_BINARY_VERSION"
```

### Run an executable archive

For a remote connection, extract the archive for your OS/architecture and run
`bin/migrate-tui` (`bin/migrate-tui.exe` on Windows). For example, from a build
checkout on macOS ARM64:

```sh
MIGRATE_BINARY_VERSION="$(node -p "require('./packages/tui/package.json').version")"
MIGRATE_BINARY_INSTALL="$(mktemp -d)"
tar -xzf "packages/tui/dist/distribution/archives/migrate-tui-$MIGRATE_BINARY_VERSION-darwin-arm64.tar.gz" \
  -C "$MIGRATE_BINARY_INSTALL"
MIGRATE_SERVER_TOKEN="<your-token>" \
  "$MIGRATE_BINARY_INSTALL/bin/migrate-tui" \
  --server https://migrate.example.com/api/migrate
```

The example extracts into a new temporary directory. Windows archives use
`.zip`; extract them before running the `.exe`. A direct remote connection needs
neither Node nor Bun. Local use of the same executable still needs Node and the
project SDK.

## Targets and cross-compilation

The shared manifest is `packages/tui/bin/binary-targets.js`. It drives build
validation, npm package names and OS/CPU/libc restrictions, and runtime selection.
It defines macOS ARM64/x64, Linux glibc ARM64/x64, Windows x64/ARM64, and Linux
musl ARM64/x64. Every x64 target uses Bun 1.3.14's baseline runtime.

```sh
pnpm --filter @migrate-sdk/tui build:binary --list-targets
pnpm --filter @migrate-sdk/tui build:binary --target darwin-arm64
pnpm --filter @migrate-sdk/tui package:binary --target darwin-arm64
```

Build another target only after provisioning its matching OpenTUI optional native
package. The builder reports a missing target package before compilation instead
of silently using the host's native library. Start with native builders;
cross-compilation does not establish that the resulting artifact runs.

The `TUI Binaries` GitHub workflow runs native jobs for macOS ARM64/x64, Linux
glibc ARM64/x64, and Windows x64. Its aggregation job requires all five matching
builds, stages the public npm distribution, and repeats installation and terminal
tests against the assembled launcher. Musl and
Windows ARM64 are defined but are not advertised as tested releases yet.

## Runtime and installation contract

A direct executable can use `--server <url>` without an installed JavaScript
runtime. Local operation still needs Node >=22.19.0 and a matching `migrate-sdk`
installed beside the selected migration configuration. Without `--config`, it
discovers that configuration using the SDK's search order and workspace
boundaries, including when launched from a nested project. It resolves the public
`migrate-sdk/server/node` entry from that project and starts it with Node;
customer modules never execute in the Bun renderer. Local SDK matching remains
exact; remote compatibility follows the Migrate Protocol version.

Package.json loading is explicitly enabled in the compiled runtime so package
exports resolve correctly. Renderer tsconfig, dotenv, and Bunfig autoloading stay
disabled. The Node server retains its existing configuration-loading behavior.

The generated npm umbrella uses the same Node command launcher for local and
global installations. It selects an exact-version native package, verifies the
executable, forwards termination signals, and needs no postinstall download or
copy. The source/workspace package uses its development Bun runtime. Only the
release job redirects Changesets to the staged native launcher. Renderer and SDK
JavaScript peers are optional so remote CLI installation does not fetch them;
programmatic users install the peers explicitly.

For public consumption, pin the project dev dependency to the SDK version and
keep the package script and lockfile with that project. Native platform packages
are selected through optional dependencies; keep optional dependencies enabled.

## Publishing

The Release workflow calls the native matrix for the same commit, waits for all
build, installation, and terminal tests, downloads the tested inputs, and runs:

```sh
pnpm --filter @migrate-sdk/tui package:release
pnpm --filter @migrate-sdk/tui publish:native
pnpm exec changeset publish
```

The first command rejects missing targets, mixed revisions/versions, modified
bytes, and incorrect executable architectures. The second verifies final npm
tarball checksums and the launcher's dependency contract, publishes the five
platform packages, waits for npm processing to make them available (up to ten
minutes per package), verifies them in the registry, and selects the staged launcher
through an ephemeral `publishConfig.directory` override. Changesets then
publishes the ordinary SDK packages and the native TUI launcher. An existing
immutable native version is reused only for the same source revision. A failed
platform publication stops the release before the launcher is advertised.

If the TUI version is already published, platform publication is skipped and
Changesets creates the usual version PR. npm versions cannot be overwritten;
merging the next version PR releases the native distribution under a new version.
The TUI GitHub release receives executable archives, metadata, and checksums.

### Initial npm package setup

Each new platform package must exist before npm can configure its trusted
publisher. Download the `tui-npm-release` artifact from a successful TUI Binaries
run and inspect `distribution.json` and `SHA256SUMS`. On a maintainer machine
with npm authentication, publish only the five platform tarballs initially:

```sh
npm login
for target in darwin-arm64 darwin-x64 linux-arm64-glibc linux-x64-glibc windows-x64; do
  npm publish "tarballs/migrate-sdk-tui-$target-$MIGRATE_BINARY_VERSION.tgz" --access public --ignore-scripts
done
```

Set `MIGRATE_BINARY_VERSION` to the artifact's recorded version before running
those commands. Do not publish the umbrella manually: Changesets owns its version
and publishes it after the platform dependencies are available.

Alternatively, `npm stage publish <tarball> --access public --ignore-scripts`
registers a new package name with a placeholder while keeping the candidate
version unpublished. This does not require publish-time 2FA. Use a bootstrap
version different from the upcoming release: staged and published versions share
the same immutable version namespace. Configure the publisher below, then let
CI publish the new release version. The unused candidate can be rejected with
`npm stage reject <stage-id>` after setup. See
[npm staging](https://docs.npmjs.com/staged-publishing/).

Configure each platform package to trust GitHub repository
`asgorobets/migrate-sdk`, workflow `release.yml`, with direct publication
allowed. The npm website's package settings support this, or npm >=11.15.0 can
configure it from the same authenticated machine:

```sh
for target in darwin-arm64 darwin-x64 linux-arm64-glibc linux-x64-glibc windows-x64; do
  npm trust github "@migrate-sdk/tui-$target" --repo asgorobets/migrate-sdk --file release.yml --allow-publish --yes
  sleep 2
done
```

See npm's [trusted publisher setup](https://docs.npmjs.com/trusted-publishers/)
and [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/).
Subsequent releases use OIDC without an npm write token. Signing and macOS
notarization can be added to native jobs later; the current release metadata
explicitly records `signed: false`.

OpenCode patterns adapted here include explicit target enumeration, native asset
selection, executable architecture checks, exact-version optional platform
packages, and publishing platforms before the launcher. See the
[pinned upstream study](./research/tui-binary-upstream-patterns.md).
