# Changelog — @linkspan/cli

Adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-14

Initial release.

### Added
- Commands: `send`, `receive` (alias `get`), `list` (alias `list-devices`, `ls`),
  `revoke` (alias `rm`), `status`, `pair`, `history`, `config`.
- `send` supports single files, multiple files / folders (packed into a ZIP via a
  dependency-free STORE-method writer), `--text`, and `--stdin`.
- Link options: `--public`, `--expires`, `--password`, `--max-downloads`, `--single-use`,
  `--name`.
- Config + history in `~/.linkspan` with `LINKSPAN_URL` / `LINKSPAN_API_KEY` overrides.
- Cross-platform bin (`linkspan`) for Linux, macOS, Windows.
