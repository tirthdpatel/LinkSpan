/**
 * LinkSpan — Shared Constants
 * Used by both signaling server and client.
 */

export const PROTOCOL_VERSION = '1.0.0';

// Transfer
export const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256KB
export const MAX_CHANNELS = 7;
export const MAX_IN_FLIGHT = 7;
export const MAX_RETRY_COUNT = 5;

// Session
export const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_PEERS_PER_SESSION = 2;
export const PAIRING_CODE_LENGTH = 6;

// Rate Limiting
export const MAX_CONNECTIONS_PER_MIN = 10;
export const MAX_SESSIONS_PER_HOUR = 5;
export const MAX_MESSAGES_PER_SEC = 100;
export const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB for signaling messages

// Signaling Message Types
export const MSG = {
  // Client → Server
  CREATE_SESSION: 'create-session',
  JOIN_SESSION: 'join-session',
  OFFER: 'offer',
  ANSWER: 'answer',
  ICE_CANDIDATE: 'ice-candidate',
  DISCONNECT: 'disconnect',

  // Server → Client
  SESSION_CREATED: 'session-created',
  PEER_JOINED: 'peer-joined',
  SESSION_ERROR: 'session-error',
  SESSION_CLOSED: 'session-closed',
};

// Transfer Protocol Message Types (over DataChannel)
export const TRANSFER_MSG = {
  FILE_META: 'file-meta',
  CHUNK_REQUEST: 'chunk-request',
  CHUNK_DATA: 'chunk-data',
  CHUNK_ACK: 'chunk-ack',
  CHUNK_NACK: 'chunk-nack',
  TRANSFER_COMPLETE: 'transfer-complete',
  RESUME_REQUEST: 'resume-request',
  RESUME_RESPONSE: 'resume-response',
};

// Error Codes
export const ERR = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_FULL: 'SESSION_FULL',
  INVALID_PAIRING_CODE: 'INVALID_PAIRING_CODE',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  TRANSFER_FAILED: 'TRANSFER_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
};

// DataChannel config
export const CHANNEL_CONFIG = {
  ordered: true,
};

export const BUFFERED_AMOUNT_LOW_THRESHOLD = 64 * 1024; // 64KB
