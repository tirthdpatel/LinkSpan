# @linkspan/cli

Share files, folders, and text from your terminal — built on
[`@linkspan/sdk`](../sdk/README.md). Linux, macOS, and Windows.

## Install

```bash
npm install -g @linkspan/cli
```

Or run without installing:

```bash
npx @linkspan/cli send ./photo.jpg
```

From a checkout of this repo:

```bash
cd cli && npm install && npm link    # exposes the `linkspan` command
```

## Configure

Point the CLI at your server (defaults to `http://127.0.0.1:10000`):

```bash
linkspan config --url https://share.example
linkspan config --api-key lk1...        # optional; enables `list`
```

Or via environment: `LINKSPAN_URL`, `LINKSPAN_API_KEY`. Config is stored in
`~/.linkspan/config.json` (mode `600`).

## Commands

```bash
# Send a single file
linkspan send report.pdf

# Send multiple files / a folder (packed into a .zip)
linkspan send ./photos ./notes.txt

# Public link, 24h expiry, password, max 5 downloads
linkspan send report.pdf --public --expires 24h --password hunter2 --max-downloads 5

# One-time link
linkspan send secret.key --single-use

# Share text or piped stdin
linkspan send --text "meet at 5pm"
git log --oneline | linkspan send --stdin --name changelog.txt

# Download (by id or URL)
linkspan receive 1a8f169316379dda8697ee39b9c1321d -o report.pdf
linkspan receive https://share.example/s/1a8f... --password hunter2

# Manage
linkspan list                       # your links (needs an API key)
linkspan revoke <id> --owner-token <token>
linkspan status                     # server + auth status
linkspan history                    # local transfer history

# Bridge to the live app
linkspan pair                       # prints a pairing code for the browser app
```

Run `linkspan --help` for the full option reference.

## How it sends

The CLI sends via **share links**: it uploads to the server and prints a download URL the
recipient opens later. This works across NAT without both peers being online — the right
model for scripting and automation. For live, peer-to-peer browser transfers, use the web
app (and `linkspan pair` to hand off a code).

Encrypt sensitive payloads before `send` if you need end-to-end confidentiality; the CLI
uploads exactly the bytes you give it.

## License

MIT
