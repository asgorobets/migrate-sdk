# Building Migrate TUI binaries

The binary pipeline compiles the TUI with pinned Bun and OpenTUI, bundles its
client dependencies, and stages platform npm packages and direct-download
archives. The existing npm publication workflow continues to ship the current
package. Generated distributions are **unsigned candidates**, marked private to
prevent accidental publication while release signing and aggregation are pending.

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

The acceptance test verifies checksums, relocates the executable, runs help and
version with no Node or Bun on PATH, installs the generated npm tarballs with
lifecycle scripts disabled, and executes a migration through a compiled client
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
| `distribution/distribution.json` | Included targets/version and `releaseReady: false` |

Each generated umbrella package references **only the targets supplied to that
packaging run**. A host-only candidate is useful for testing; it must not become
the multi-platform public release. All inputs must match the current package,
Bun, and OpenTUI versions and source revision. Packaging rejects modified bytes
and executables whose file headers disagree with the target architecture.

## Install a compiled candidate

Native distributions are currently available as local build output and CI
artifacts. The registry's `@migrate-sdk/tui@latest` still uses the existing
package-supplied Bun runtime. Use the candidate artifacts below to try the
compiled distribution before native npm publication is enabled.

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
package is needed for this preview because it has not been published to npm;
published native distributions will select it automatically through optional
dependencies. The install works with lifecycle scripts disabled and needs no
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
`>=22.19.0` and the matching project SDK. Once native packages are published,
replace the tarball installs with an exact project dependency:

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
glibc ARM64/x64, and Windows x64 and uploads the accepted candidates. Musl and
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
copy. The source/workspace package keeps using its current package-pinned Bun
runtime until publication moves to the staged distribution.

For public consumption, pin the project dev dependency to the SDK version and
keep the package script and lockfile with that project. Native platform packages
are selected through optional dependencies; keep optional dependencies enabled.

## Before public binary publication

Complete target execution tests, aggregate the supported targets from one version
and commit, preserve dependency license notices, sign and verify the macOS and
Windows artifacts, define the macOS notarization step, and rebuild checksums from
the signed archives. Validate the distributable bytes and only then remove the
candidate packages' private markers and publish native packages before the
umbrella. The source npm release remains independent until these gates pass.

OpenCode patterns adapted here include explicit target enumeration, deliberate
native asset selection, executable architecture checks, exact-version platform
packages, and separate build/package stages. See the
[pinned upstream study](./research/tui-binary-upstream-patterns.md) and
[strategy](./research/tui-standalone-binary-strategy.md).
