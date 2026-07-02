/**
 * OpenAPI 3.1 specification for the LinkSpan REST API (Feature 17).
 *
 * Served live at GET /api/v1/openapi.json and also exported to docs/api/openapi.json for
 * tooling (Swagger UI, client generators, SDK type generation). Kept in code so it can
 * never drift from the deployed baseUrl, and so a single source describes the contract.
 */

import {
    SHARE_MAX_BLOB_BYTES,
    SHARE_EXPIRY_PRESETS,
} from '../../../shared/constants.js';

export function buildOpenApiSpec({ baseUrl = '' } = {}) {
    const server = baseUrl ? `${baseUrl}/api/v1` : '/api/v1';
    return {
        openapi: '3.1.0',
        info: {
            title: 'LinkSpan REST API',
            version: '1.0.0',
            description:
                'Programmatic access to LinkSpan share links and signaling sessions. ' +
                'Share links upload (client-encrypted) bytes to the server so a recipient can ' +
                'download later, with expiry, password protection, download limits, single-use, ' +
                'and revocation.',
            license: { name: 'MIT' },
        },
        servers: [{ url: server }],
        security: [{ ApiKeyAuth: [] }, {}],
        tags: [
            { name: 'links', description: 'Temporary and public share links' },
            { name: 'sessions', description: 'WebRTC signaling sessions' },
            { name: 'meta', description: 'Discovery and health' },
        ],
        components: {
            securitySchemes: {
                ApiKeyAuth: { type: 'http', scheme: 'bearer', description: 'API key as Bearer token (or X-API-Key header).' },
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: {
                        error: {
                            type: 'object',
                            properties: { code: { type: 'string' }, message: { type: 'string' } },
                            required: ['code', 'message'],
                        },
                    },
                },
                CreateLinkRequest: {
                    type: 'object',
                    required: ['filename', 'size'],
                    properties: {
                        filename: { type: 'string', maxLength: 255 },
                        size: { type: 'integer', minimum: 0, maximum: SHARE_MAX_BLOB_BYTES },
                        contentType: { type: 'string', default: 'application/octet-stream' },
                        visibility: { type: 'string', enum: ['temp', 'public'], default: 'temp' },
                        expiresIn: {
                            description: 'Preset (' + Object.keys(SHARE_EXPIRY_PRESETS).join(', ') + ') or custom milliseconds.',
                            oneOf: [{ type: 'string' }, { type: 'integer' }],
                        },
                        password: { type: 'string', maxLength: 256, description: 'Optional download password.' },
                        maxDownloads: { type: 'integer', minimum: 1, description: 'Multi-use cap; omit for unlimited.' },
                        singleUse: { type: 'boolean', description: 'Reaped after the first successful download.' },
                        metadata: { type: 'object', description: 'Opaque client metadata (e.g. {"encrypted":true}).' },
                    },
                },
                ShareLink: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        filename: { type: 'string' },
                        size: { type: 'integer' },
                        contentType: { type: 'string' },
                        visibility: { type: 'string', enum: ['temp', 'public'] },
                        createdAt: { type: 'integer' },
                        expiresAt: { type: 'integer' },
                        status: { type: 'string', enum: ['pending', 'ready'] },
                        passwordProtected: { type: 'boolean' },
                        maxDownloads: { type: ['integer', 'null'] },
                        singleUse: { type: 'boolean' },
                        downloadCount: { type: 'integer' },
                        revoked: { type: 'boolean' },
                        url: { type: 'string' },
                        downloadUrl: { type: 'string' },
                    },
                },
                CreateLinkResponse: {
                    allOf: [
                        { $ref: '#/components/schemas/ShareLink' },
                        {
                            type: 'object',
                            properties: {
                                uploadToken: { type: 'string', description: 'Present once; use with PUT .../content.' },
                                ownerToken: { type: 'string', description: 'Anonymous capability secret for revoke. Store it.' },
                                upload: { type: 'object' },
                            },
                        },
                    ],
                },
            },
        },
        paths: {
            '/': { get: { tags: ['meta'], summary: 'API info & capabilities', responses: { 200: { description: 'OK' } } } },
            '/health': { get: { tags: ['meta'], summary: 'Health & store stats', responses: { 200: { description: 'OK' } } } },
            '/turn-credentials': {
                get: {
                    tags: ['meta'],
                    summary: 'Ephemeral TURN/ICE server credentials (no auth)',
                    description: 'Short-lived ICE server list minted server-side (Cloudflare Realtime TURN or coturn static-secret). Returns { iceServers: [], ttl: 0 } when no TURN provider is configured — clients then proceed STUN-only.',
                    responses: { 200: { description: 'ICE servers + ttl (seconds)', content: { 'application/json': { schema: {
                        type: 'object',
                        properties: {
                            iceServers: { type: 'array', items: { type: 'object' } },
                            ttl: { type: 'integer', description: 'Credential lifetime in seconds (0 = none issued)' },
                        },
                    } } } } },
                },
            },
            '/telemetry': {
                post: {
                    tags: ['meta'],
                    summary: 'Opt-in aggregate telemetry (anonymized, pre-bucketed; no auth)',
                    description: 'Clients that have opted in may POST a single anonymized, pre-bucketed transfer event. No filename, byte count, duration value, identity, or per-transfer id is accepted. Always returns 204 (invalid events are silently dropped).',
                    requestBody: {
                        required: true,
                        content: { 'application/json': { schema: {
                            type: 'object',
                            properties: {
                                outcome: { type: 'string', enum: ['success', 'failure'] },
                                mode: { type: 'string', enum: ['p2p', 'relay'] },
                                sizeBucket: { type: 'string', enum: ['lt1mb', '1to10mb', '10to100mb', '100mbto1gb', 'gt1gb'] },
                                durationBucket: { type: 'string', enum: ['lt1s', '1to10s', '10to60s', '1to5m', 'gt5m'] },
                            },
                            required: ['outcome', 'mode', 'sizeBucket', 'durationBucket'],
                        } } },
                    },
                    responses: { 204: { description: 'Recorded (or silently dropped if invalid)' } },
                },
            },
            '/links': {
                post: {
                    tags: ['links'], summary: 'Create a share link', security: [{ ApiKeyAuth: [] }, {}],
                    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateLinkRequest' } } } },
                    responses: {
                        201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateLinkResponse' } } } },
                        400: errRef('Validation error'), 401: errRef('Unauthorized'), 429: errRef('Rate limited'),
                    },
                },
                get: {
                    tags: ['links'], summary: "List the caller's links", security: [{ ApiKeyAuth: [] }],
                    responses: { 200: { description: 'OK' }, 401: errRef('API key required') },
                },
            },
            '/links/{id}/content': {
                put: {
                    tags: ['links'], summary: 'Upload bytes for a reserved link',
                    parameters: [pathId(), { name: 'X-Upload-Token', in: 'header', required: true, schema: { type: 'string' } }],
                    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: { description: 'Stored', content: { 'application/json': { schema: { $ref: '#/components/schemas/ShareLink' } } } }, 401: errRef('Bad token'), 410: errRef('Expired'), 413: errRef('Too large') },
                },
            },
            '/links/{id}': {
                get: { tags: ['links'], summary: 'Link metadata', parameters: [pathId()], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ShareLink' } } } }, 404: errRef('Not found'), 410: errRef('Expired') } },
                delete: { tags: ['links'], summary: 'Revoke a link', security: [{ ApiKeyAuth: [] }], parameters: [pathId(), { name: 'X-Owner-Token', in: 'header', schema: { type: 'string' } }], responses: { 200: { description: 'Revoked' }, 401: errRef('Unauthorized'), 403: errRef('Not owner'), 404: errRef('Not found') } },
            },
            '/links/{id}/download': {
                get: {
                    tags: ['links'], summary: 'Download link bytes',
                    parameters: [pathId(), { name: 'X-Share-Password', in: 'header', schema: { type: 'string' } }, { name: 'password', in: 'query', schema: { type: 'string' } }],
                    responses: { 200: { description: 'Bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 401: errRef('Password required'), 403: errRef('Wrong password'), 404: errRef('Not found'), 410: errRef('Expired/limit reached'), 429: errRef('Rate limited') },
                },
            },
            '/sessions': {
                post: { tags: ['sessions'], summary: 'Create a signaling session', security: [{ ApiKeyAuth: [] }, {}], responses: { 201: { description: 'Created' } } },
            },
            '/sessions/{id}': {
                get: { tags: ['sessions'], summary: 'Session status', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' }, 404: errRef('Not found') } },
            },
        },
    };
}

function pathId() {
    return { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{32}$' } };
}
function errRef(description) {
    return { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
}
