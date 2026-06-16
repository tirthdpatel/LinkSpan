/**
 * AuditLogger — Persists security-relevant events to PostgreSQL.
 *
 * All writes are fire-and-forget: errors are logged but never propagated
 * to the caller, so database unavailability never blocks real-time paths.
 *
 * Uses dynamic import() for @prisma/client so the server starts cleanly
 * even when DATABASE_URL is not set or @prisma/client is not installed.
 *
 * The AuditEvent enum must match the Prisma schema (database/schema.prisma).
 */

let prisma = null;
let prismaInitAttempted = false;

async function getClient() {
  if (prisma) return prisma;
  if (prismaInitAttempted) return null;
  if (!process.env.DATABASE_URL) return null;

  prismaInitAttempted = true;
  try {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ log: ['error'] });
  } catch {
    // @prisma/client not installed or DB not reachable — operate in no-op mode
    return null;
  }
  return prisma;
}

/** Mirrors the AuditEvent enum in schema.prisma */
export const AuditEvent = Object.freeze({
  SESSION_CREATED:          'SESSION_CREATED',
  SESSION_JOINED:           'SESSION_JOINED',
  SESSION_JOIN_FAILED:      'SESSION_JOIN_FAILED',
  SESSION_CLOSED:           'SESSION_CLOSED',
  TRANSFER_STARTED:         'TRANSFER_STARTED',
  TRANSFER_COMPLETED:       'TRANSFER_COMPLETED',
  TRANSFER_FAILED:          'TRANSFER_FAILED',
  TRANSFER_CANCELLED:       'TRANSFER_CANCELLED',
  RATE_LIMIT_HIT:           'RATE_LIMIT_HIT',
  BRUTE_FORCE_LOCKOUT:      'BRUTE_FORCE_LOCKOUT',
  TOKEN_VALIDATION_FAILED:  'TOKEN_VALIDATION_FAILED',
  RELAY_ACTIVATED:          'RELAY_ACTIVATED',
  ICE_RESTART:              'ICE_RESTART',
  INVALID_MESSAGE:          'INVALID_MESSAGE',
});

export const Severity = Object.freeze({
  DEBUG: 'DEBUG',
  INFO:  'INFO',
  WARN:  'WARN',
  ERROR: 'ERROR',
});

export class AuditLogger {
  /**
   * Log any audit event.
   *
   * @param {object} params
   * @param {keyof typeof AuditEvent} params.eventType
   * @param {string}                  [params.ip]
   * @param {string}                  [params.sessionId]
   * @param {string}                  [params.peerId]
   * @param {object}                  [params.detail]      Extra context (JSON)
   * @param {keyof typeof Severity}   [params.severity]
   */
  async log(params) {
    // Structured JSON logging to stdout/stderr — always emitted, even when no
    // database is configured (Phase 6.2). This is the single, parseable event
    // stream; sessionId/peerId make transfers traceable (Phase 6.1). Set
    // AUDIT_LOG_STDOUT=false to silence (e.g. when shipping only to the DB).
    if (process.env.AUDIT_LOG_STDOUT !== 'false') {
      const record = {
        ts: new Date().toISOString(),
        event: params.eventType,
        severity: params.severity ?? 'INFO',
        ...(params.ip && { ip: params.ip }),
        ...(params.sessionId && { sessionId: params.sessionId }),
        ...(params.peerId && { peerId: params.peerId }),
        ...(params.detail && { detail: params.detail }),
      };
      const line = JSON.stringify(record);
      if (record.severity === 'ERROR') console.error(line);
      else console.log(line);
    }

    const db = await getClient();
    if (!db) return;
    try {
      await db.auditLog.create({
        data: {
          eventType: params.eventType,
          ip:        params.ip        ?? null,
          sessionId: params.sessionId ?? null,
          peerId:    params.peerId    ?? null,
          detail:    params.detail    ?? undefined,
          severity:  params.severity  ?? 'INFO',
        },
      });
    } catch (err) {
      console.error('[AuditLogger] write error:', err.message);
    }
  }

  // ── Convenience wrappers ──────────────────────────────────────────────────

  sessionCreated(ip, sessionId) {
    return this.log({ eventType: AuditEvent.SESSION_CREATED, ip, sessionId });
  }

  sessionJoined(ip, sessionId, peerId) {
    return this.log({ eventType: AuditEvent.SESSION_JOINED, ip, sessionId, peerId });
  }

  sessionJoinFailed(ip, detail) {
    return this.log({ eventType: AuditEvent.SESSION_JOIN_FAILED, ip, detail, severity: 'WARN' });
  }

  sessionClosed(sessionId, detail) {
    return this.log({ eventType: AuditEvent.SESSION_CLOSED, sessionId, detail });
  }

  rateLimitHit(ip, detail) {
    return this.log({ eventType: AuditEvent.RATE_LIMIT_HIT, ip, detail, severity: 'WARN' });
  }

  bruteForceLockout(ip, detail) {
    return this.log({ eventType: AuditEvent.BRUTE_FORCE_LOCKOUT, ip, detail, severity: 'ERROR' });
  }

  /**
   * @param {string} ip
   * @param {string} sessionId
   * @param {object} [detail]
   */
  tokenValidationFailed(ip, sessionId, detail) {
    return this.log({
      eventType: AuditEvent.TOKEN_VALIDATION_FAILED,
      ip,
      sessionId,
      detail,
      severity: 'WARN',
    });
  }

  relayActivated(sessionId, detail) {
    return this.log({ eventType: AuditEvent.RELAY_ACTIVATED, sessionId, detail });
  }

  iceRestart(sessionId, peerId) {
    return this.log({ eventType: AuditEvent.ICE_RESTART, sessionId, peerId });
  }

  invalidMessage(ip, detail) {
    return this.log({ eventType: AuditEvent.INVALID_MESSAGE, ip, detail, severity: 'WARN' });
  }

  // NOTE: transfers are end-to-end between peers and never observed by the server, so
  // there are intentionally no transferStarted/Completed/Failed helpers. The
  // AuditEvent.TRANSFER_* values are kept in the taxonomy for completeness; if a code
  // path ever needs to emit one, call log({ eventType: AuditEvent.TRANSFER_*, ... })
  // directly (mirrors how room events are emitted via recordAudit()).

  /**
   * Query recent audit logs (for admin UI).
   * @param {{ eventType?: string, ip?: string, limit?: number }} [filter]
   */
  async query(filter = {}) {
    const db = await getClient();
    if (!db) return [];
    try {
      return await db.auditLog.findMany({
        where: {
          ...(filter.eventType && { eventType: filter.eventType }),
          ...(filter.ip        && { ip: filter.ip }),
        },
        orderBy: { timestamp: 'desc' },
        take:    filter.limit ?? 100,
      });
    } catch (err) {
      console.error('[AuditLogger] query error:', err.message);
      return [];
    }
  }
}

export const auditLogger = new AuditLogger();
