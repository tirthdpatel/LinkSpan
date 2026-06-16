/**
 * linkspan CLI entry point (Feature 16).
 *
 * `run(argv, deps)` parses arguments, builds a context, and dispatches to a command.
 * Dependencies (client, io, fsapi, config/history fns) are injectable so the whole CLI —
 * including arg parsing and dispatch — is unit-testable without real I/O or the network.
 * The SDK is imported lazily, only when no client is injected, so this module loads in
 * tests that supply their own client.
 */

import fsp from 'node:fs/promises';
import { COMMANDS, CliError, formatBytes } from './commands.js';
import { loadConfig, saveConfig, loadHistory, appendHistory, configDir } from './config.js';

const VERSION = '0.1.0';

const ALIASES = { get: 'receive', 'list-devices': 'list', ls: 'list', rm: 'revoke' };

const HELP = `linkspan ${VERSION} — share files from the command line

Usage: linkspan <command> [options] [args]

Commands:
  send <paths...>          Share file(s)/folder(s) as a download link
       --text <msg>          Share a text message instead of files
       --stdin               Read the payload from stdin
       --public              Public link (default: temporary)
       --expires <v>         5m | 1h | 24h | 7d | <milliseconds>
       --password <pw>       Require a password to download
       --max-downloads <n>   Limit total downloads (multi-use)
       --single-use          Reap after the first download
       --name <filename>     Override the stored filename
       --no-encrypt          Upload plaintext (default: AES-256-GCM, key in link fragment)
  receive <id|url>         Download a link (alias: get)
       -o, --output <path>   Output file path
       --password <pw>       Download password
       --key <k>             Decryption key (else read from the link's #k= fragment)
  list                     List your links (needs an API key; alias: list-devices, ls)
  revoke <id>              Revoke a link (alias: rm)
       --owner-token <t>     Capability token for anonymously-created links
  status                   Show server + auth status
  pair                     Create a pairing code for the LinkSpan app
  history                  Show local transfer history
  login                    Log in (--email --password [--register])
  logout                   Log out and clear stored tokens
  whoami                   Show the logged-in account
  config                   Show config, or set with --url / --api-key

Global:
  --url <baseUrl>          Server URL (or LINKSPAN_URL)
  --api-key <key>          API key (or LINKSPAN_API_KEY)
  -h, --help               Show this help
  -v, --version            Show version

Config dir: ${configDir()}
`;

/** Tiny argv parser: --flag value, --flag=value, --bool, -o value, positionals. */
export function parseArgs(argv) {
    const flags = {};
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { flags.help = true; continue; }
        if (a === '-v' || a === '--version') { flags.version = true; continue; }
        if (a === '-o') { flags.output = argv[++i]; continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
            const key = a.slice(2);
            const next = argv[i + 1];
            // Boolean flags (no value follows, or next is another flag).
            if (next === undefined || next.startsWith('--') || isBooleanFlag(key)) { flags[key] = true; }
            else { flags[key] = next; i++; }
            continue;
        }
        args.push(a);
    }
    return { flags, args };
}

const BOOLEAN_FLAGS = new Set(['public', 'single-use', 'stdin', 'help', 'version', 'no-encrypt', 'register']);
function isBooleanFlag(k) { return BOOLEAN_FLAGS.has(k); }

function defaultIo() {
    return {
        out: (s) => process.stdout.write(s + '\n'),
        info: (s) => process.stderr.write(s + '\n'),
        error: (s) => process.stderr.write(s + '\n'),
        readStdin: async () => {
            const chunks = [];
            for await (const c of process.stdin) chunks.push(c);
            return Buffer.concat(chunks);
        },
    };
}

const defaultFsApi = {
    readFile: (p) => fsp.readFile(p),
    writeFile: (p, d) => fsp.writeFile(p, d),
    stat: (p) => fsp.stat(p),
    readdir: (p, o) => fsp.readdir(p, o),
};

/**
 * Run the CLI.
 * @param {string[]} argv  Arguments after the node/script (process.argv.slice(2)).
 * @param {object} [deps]  { client, io, fsapi, config, configFns } for testing.
 * @returns {Promise<number>} exit code
 */
export async function run(argv, deps = {}) {
    const io = deps.io || defaultIo();
    const fsapi = deps.fsapi || defaultFsApi;
    const { flags, args } = parseArgs(argv);

    if (flags.version) { io.out(VERSION); return 0; }
    let command = args.shift();
    command = ALIASES[command] || command;
    if (!command || flags.help || command === 'help') { io.out(HELP); return command ? 0 : (flags.help ? 0 : 1); }

    // Effective config (env + file) with per-invocation overrides.
    const config = deps.config || loadConfig();
    if (flags.url) config.baseUrl = flags.url;
    if (flags['api-key']) config.apiKey = flags['api-key'];

    // `config` command doesn't need a client.
    if (command === 'config') {
        if (flags.url || flags['api-key']) {
            const saved = await saveConfig({ baseUrl: flags.url, apiKey: flags['api-key'] });
            io.out('Saved config:'); io.out(JSON.stringify({ ...saved, apiKey: saved.apiKey ? '***' : undefined }, null, 2));
        } else {
            io.out(JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey ? '***' : null }, null, 2));
        }
        return 0;
    }

    const handler = COMMANDS[command];
    if (!handler) { io.error(`Unknown command: ${command}\n`); io.out(HELP); return 1; }

    // Build the client (injected in tests; lazily import the SDK otherwise).
    let client = deps.client;
    if (!client) {
        const { LinkSpanClient } = await import('@linkspan/sdk');
        client = new LinkSpanClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
    }
    // Apply a stored account access token so authenticated commands work after `login`.
    if (config.accessToken && !client.accessToken) client.accessToken = config.accessToken;

    const ctx = {
        client, args, flags, config, io, fsapi,
        saveConfig: deps.saveConfig || saveConfig,
        recordHistory: deps.recordHistory || appendHistory,
        loadHistory: deps.loadHistory || loadHistory,
    };

    try {
        await handler(ctx);
        return 0;
    } catch (err) {
        if (err instanceof CliError) { io.error(`Error: ${err.message}`); return 1; }
        if (err && err.name === 'LinkSpanError') {
            io.error(`Error (${err.code}${err.status ? ` ${err.status}` : ''}): ${err.message}`);
            return 1;
        }
        io.error(`Unexpected error: ${err?.message || err}`);
        return 1;
    }
}

export { formatBytes };
