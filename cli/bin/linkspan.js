#!/usr/bin/env node
/**
 * linkspan CLI binary. Thin shim → src/cli.js run(). Works on Linux, macOS, and Windows
 * (npm generates a .cmd shim on Windows from the `bin` field in package.json).
 */
import { run } from '../src/cli.js';

run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
        process.stderr.write(`Fatal: ${err?.message || err}\n`);
        process.exit(1);
    });
