/**
 * CLI configuration + local history persistence.
 *
 * Config lives at $LINKSPAN_CONFIG_DIR or ~/.linkspan:
 *   config.json   { baseUrl, apiKey }
 *   history.json  [{ direction, id, filename, size, url, at }]
 *
 * Environment overrides (LINKSPAN_URL, LINKSPAN_API_KEY) take precedence over config.json
 * so the CLI works in CI / ephemeral shells without writing files.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function configDir() {
    return process.env.LINKSPAN_CONFIG_DIR || path.join(os.homedir(), '.linkspan');
}

const CONFIG_FILE = () => path.join(configDir(), 'config.json');
const HISTORY_FILE = () => path.join(configDir(), 'history.json');
const MAX_HISTORY = 500;

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

/** Effective config: file values overlaid with environment overrides. */
export function loadConfig() {
    const file = readJson(CONFIG_FILE(), {});
    return {
        baseUrl: process.env.LINKSPAN_URL || file.baseUrl || 'http://127.0.0.1:10000',
        apiKey: process.env.LINKSPAN_API_KEY || file.apiKey || null,
        accessToken: process.env.LINKSPAN_ACCESS_TOKEN || file.accessToken || null,
        refreshToken: file.refreshToken || null,
    };
}

export async function saveConfig(partial) {
    const dir = configDir();
    await fsp.mkdir(dir, { recursive: true });
    const current = readJson(CONFIG_FILE(), {});
    const next = { ...current, ...partial };
    // Drop nulls so `--api-key ""` can clear a value.
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
    await fsp.writeFile(CONFIG_FILE(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
}

export function loadHistory() {
    return readJson(HISTORY_FILE(), []);
}

export async function appendHistory(entry) {
    const dir = configDir();
    await fsp.mkdir(dir, { recursive: true });
    const list = loadHistory();
    list.unshift({ ...entry, at: Date.now() });
    const trimmed = list.slice(0, MAX_HISTORY);
    await fsp.writeFile(HISTORY_FILE(), JSON.stringify(trimmed, null, 2) + '\n', { mode: 0o600 });
    return trimmed;
}
