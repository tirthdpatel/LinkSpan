import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@shared': path.resolve(__dirname, '../shared'),
        },
    },
    server: {
        port: 5173,
        open: true,
    },
    build: {
        outDir: 'dist',
        sourcemap: false,
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['react', 'react-dom'],
                },
            },
        },
    },
    test: {
        // Use Node environment: gives us access to node:crypto (Web Crypto API)
        // and avoids jsdom limitations (no IndexedDB, no SubtleCrypto).
        environment: 'node',
        globals: false,
        // Make Web Crypto available globally (Node 18 has it under globalThis.crypto)
        setupFiles: ['./src/__tests__/setup.js'],
        alias: {
            '@shared': path.resolve(__dirname, '../shared'),
            '@': path.resolve(__dirname, './src'),
        },
    },
});

