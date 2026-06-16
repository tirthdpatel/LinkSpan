# Changelog — @linkspan/sdk

All notable changes to the SDK are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-14

Initial release.

### Added
- `LinkSpanClient` with the stable share-link surface: `createLink`, `uploadContent`,
  `createShare`, `getLink`, `download`, `downloadStream`, `revoke`, `listLinks`.
- Signaling bridge: `createSession`, `getSession`.
- `info()` / `health()` discovery.
- `LinkSpanError` with `code` / `status` / `body`.
- First-class TypeScript types (`index.d.ts`).
- Browser + Node 18+ support via global `fetch`; zero runtime dependencies.
