// Type definitions for @linkspan/sdk
// Provides the "TypeScript SDK": full typing over the same JS runtime.

export type ShareVisibility = 'temp' | 'public';
export type ExpiryPreset = '5m' | '1h' | '24h' | '7d';

export interface CreateLinkOptions {
  /** Display filename (sanitized server-side). */
  filename?: string;
  /** Byte size. Auto-derived by createShare() from the data. */
  size?: number;
  contentType?: string;
  visibility?: ShareVisibility;
  /** Preset string or custom milliseconds (clamped to the server's bounds). */
  expiresIn?: ExpiryPreset | number | string;
  /** Optional download password. */
  password?: string;
  /** Cap on total downloads (multi-use). Omit for unlimited. */
  maxDownloads?: number;
  /** Reaped after the first successful download. */
  singleUse?: boolean;
  /** Opaque client metadata, e.g. { encrypted: true }. */
  metadata?: Record<string, unknown>;
}

export interface ShareLink {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  visibility: ShareVisibility;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'ready';
  passwordProtected: boolean;
  maxDownloads: number | null;
  singleUse: boolean;
  downloadCount: number;
  revoked: boolean;
  metadata?: Record<string, unknown>;
  url: string;
  downloadUrl: string;
}

export interface CreatedLink extends ShareLink {
  /** One-time token to upload content (PUT /links/:id/content). */
  uploadToken: string;
  /** Capability secret for anonymous revoke (only when created without an API key). */
  ownerToken?: string;
  /** Base64url AES-256-GCM key — present only when createShare was called with `encrypt`. */
  encryptionKey?: string;
  upload?: { method: string; url: string; header: string; maxBytes: number };
}

/** Options for createShare(), including optional client-side encryption. */
export interface CreateShareOptions extends CreateLinkOptions {
  /** Encrypt content client-side before upload. `true` generates a key (returned as
   *  `encryptionKey`); a base64url string reuses that specific key. */
  encrypt?: boolean | string;
}

export interface SessionInfo {
  sessionId: string;
  pairingCode: string;
  peerId: string;
  token: string;
}

export type WebhookEvent =
  | 'share.created' | 'share.uploaded' | 'share.downloaded' | 'share.revoked' | 'share.expired'
  | 'session.created' | 'account.created' | 'room.created' | 'room.peer_joined' | '*';

export interface CreateWebhookOptions {
  url: string;
  events: WebhookEvent[];
  /** Optional signing secret; one is generated if omitted (returned once on create). */
  secret?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: number;
  deliveryCount: number;
  /** Present only in the create response. */
  secret?: string;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: 'success' | 'failed';
  attempts: number;
  statusCode: number | null;
  error: string | null;
  at: string;
}

export interface LinkSpanClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type UploadData = Uint8Array | ArrayBuffer | Blob | ReadableStream | string;

export class LinkSpanError extends Error {
  code: string;
  status?: number;
  body?: unknown;
  constructor(code: string, message: string, status?: number, body?: unknown);
}

export interface Account { id: string; email: string; provider: string | null; createdAt: number; }
export interface AuthSession { account: Account; accessToken: string; refreshToken: string; expiresIn: number; }

export class LinkSpanClient {
  readonly baseUrl: string;
  readonly apiBase: string;
  apiKey: string | null;
  accessToken: string | null;
  constructor(opts: LinkSpanClientOptions);

  setAccessToken(token: string | null): void;
  register(creds: { email: string; password: string }): Promise<AuthSession>;
  login(creds: { email: string; password: string }): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  logout(refreshToken: string): Promise<{ ok: boolean }>;
  me(): Promise<{ account: Account }>;
  createApiKey(opts?: { scopes?: string[]; label?: string; expiresInMs?: number }): Promise<{ id: string; key: string; scopes: string[]; label: string | null }>;
  listApiKeys(): Promise<{ apiKeys: Array<{ id: string; label: string | null; scopes: string[]; createdAt: number; expiresAt: number | null }> }>;
  revokeApiKey(id: string): Promise<{ revoked: boolean; id: string }>;

  info(): Promise<Record<string, unknown>>;
  health(): Promise<Record<string, unknown>>;

  createLink(options: CreateLinkOptions): Promise<CreatedLink>;
  uploadContent(id: string, uploadToken: string, data: UploadData): Promise<ShareLink>;
  createShare(data: Uint8Array | ArrayBuffer | Blob | string, options?: CreateShareOptions): Promise<CreatedLink>;
  getLink(id: string): Promise<ShareLink>;
  download(id: string, opts?: { password?: string; decryptionKey?: string }): Promise<Uint8Array>;
  downloadStream(id: string, opts?: { password?: string }): Promise<Response>;
  revoke(id: string, opts?: { ownerToken?: string }): Promise<{ revoked: boolean; id: string }>;
  listLinks(): Promise<{ links: ShareLink[]; count: number }>;

  createWebhook(opts: CreateWebhookOptions): Promise<Webhook>;
  listWebhooks(): Promise<{ webhooks: Webhook[]; count: number }>;
  deleteWebhook(id: string): Promise<{ deleted: boolean; id: string }>;
  testWebhook(id: string): Promise<{ result: unknown }>;
  webhookDeliveries(id: string): Promise<{ deliveries: WebhookDelivery[]; count: number }>;

  createSession(): Promise<SessionInfo>;
  getSession(id: string): Promise<Record<string, unknown>>;
}

// ── Content encryption helpers (also available as named exports) ──
/** Generate a fresh AES-256-GCM key. */
export function generateKey(): Promise<CryptoKey>;
/** Export a key to a compact base64url string. */
export function exportKey(key: CryptoKey): Promise<string>;
/** Import a key from the base64url string produced by exportKey(). */
export function importKey(b64: string): Promise<CryptoKey>;
/** Encrypt bytes → [IV][ciphertext+tag]. */
export function encryptBytes(key: CryptoKey, bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array>;
/** Decrypt bytes produced by encryptBytes(). Throws on wrong key / tampering. */
export function decryptBytes(key: CryptoKey, bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array>;
/** Marker written to a link's metadata.encrypted. */
export const ENCRYPTION_SCHEME: 'aes-256-gcm';
/** Verify an inbound webhook's X-LinkSpan-Signature header over the raw request body. */
export function verifyWebhookSignature(
  secret: string,
  signatureHeader: string,
  rawBody: string,
  opts?: { toleranceSec?: number; now?: () => number },
): Promise<boolean>;

export default LinkSpanClient;
