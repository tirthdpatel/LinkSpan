#!/bin/sh
# coturn entrypoint — injects the values coturn can't expand itself.
#
# coturn does not perform shell/${VAR} substitution inside turnserver.conf, so the
# public IP and shared secret are passed as CLI flags here instead.
#
#   TURN_SECRET   (required) — REST-API shared secret (matches the signaling server)
#   EXTERNAL_IP   (optional) — public IP; auto-detected via curl/wget if unset
set -eu

if [ -z "${TURN_SECRET:-}" ]; then
  echo "[coturn] ERROR: TURN_SECRET environment variable is required." >&2
  exit 1
fi

# Resolve the public IP at runtime if not provided explicitly.
EXTERNAL_IP="${EXTERNAL_IP:-}"
if [ -z "$EXTERNAL_IP" ]; then
  if command -v curl >/dev/null 2>&1; then
    EXTERNAL_IP="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    EXTERNAL_IP="$(wget -qO- https://ifconfig.me 2>/dev/null || true)"
  fi
fi

set -- turnserver -c /etc/turnserver.conf --static-auth-secret="$TURN_SECRET"
if [ -n "$EXTERNAL_IP" ]; then
  echo "[coturn] Using external-ip=$EXTERNAL_IP"
  set -- "$@" --external-ip="$EXTERNAL_IP"
else
  echo "[coturn] WARNING: no EXTERNAL_IP set and auto-detect failed; relying on coturn defaults." >&2
fi

exec "$@"
