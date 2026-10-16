# Package and upstream Effect boundary

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Create `packages/files-sdk` with curated role subpaths and shared public object
schemas. Reuse `files-sdk/effect` directly, mapping its errors at each migration
role boundary. Follow existing package build, peer, declaration, testing, and
publish conventions. Consult effect-solutions before writing Effect code.

## Acceptance criteria

- [x] `files-sdk` minimum 3.1.1 works with the catalog's Effect 4.0.5 and current migrate-sdk.
- [x] Normal integration imports do not import unused provider SDKs.
- [x] Source, destination, and store can bind three different Files instances without service-tag collision.
- [x] A shared store layer preserves a shared local serialization boundary.
- [x] Public import/type smoke tests pass against packed emitted output; internal paths remain blocked.
- [x] Root package build/check/test filters include the new package.
- [x] Typed errors distinguish missing, unauthorized, unsupported, conflict, transient provider, and known applied outcomes without leaking secrets.

## Blocked by

None. The required guides were consulted with a Bun-backed effect-solutions CLI; installed Effect source replaced the unavailable configured clone.

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.
