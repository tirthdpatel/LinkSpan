# Contributing to LinkSpan

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

1. Fork and clone the repository
2. Install dependencies for both server and client:
   ```bash
   cd server && npm install
   cd ../client && npm install
   ```
3. Start development servers:
   ```bash
   # Terminal 1
   cd server && npm run dev

   # Terminal 2
   cd client && npm run dev
   ```

## Guidelines

- **Code style**: Run `npm run lint` before committing
- **Commits**: Use clear, descriptive commit messages
- **Tests**: Add tests for new functionality where applicable
- **PRs**: Fill out the PR template completely

## Architecture

Read [docs/architecture.md](docs/architecture.md) for technical decisions and [docs/protocol.md](docs/protocol.md) for the signaling and transfer protocol.

## Reporting Issues

Use the [issue templates](.github/ISSUE_TEMPLATE/) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
