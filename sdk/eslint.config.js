import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['node_modules/**'] },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            // The SDK runs in both Node and the browser, so allow both global sets.
            globals: { ...globals.node, ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
];
