---
"migrate-sdk": minor
"@migrate-sdk/tui": minor
---

Expose the Migrate Server through a Web-standard Effect RPC HTTP handler and
add bounded, resumable run-observation leases with opaque resume tokens and
absolute durable progress snapshots. Lease resume tokens retain the durable
observation anchor so reconnects address the selected run directly. Transient
lifecycle states and warnings are delivered with the next progress or completion
checkpoint, and a terminal event is emitted only after the final durable
progress snapshot.

Let the TUI connect to a remote Migrate Server with `--server`, authenticate
with an environment-provided Bearer token, reconnect observation leases after
HTTP or serverless function boundaries, and expose the same complete operation
contract used by local Migrate Servers. Remote connections require HTTPS outside
loopback development and a matching Migrate SDK version, while HTTP hosts must
provide request authorization or explicitly delegate it to authenticated
infrastructure.

Separate registry-backed Migrate Server construction from local
`migrate.config.*` discovery. Remote hosts can construct the server directly
from an imported registry and executable, while config paths remain private to
the local CLI/TUI bootstrap.
