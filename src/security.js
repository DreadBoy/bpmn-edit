// Request classification and secret checks for the security model (PLAN.md, "Security model"):
//
// - Host secret: random, created at startup, shown only in the URL the CLI prints/opens. The host's page
//   sends it on host-only calls (`X-Bpmn-Edit-Host` header) and on its WebSocket handshake (`?host=`).
// - Session token: created when sharing starts, rotated when it stops; collaborators use `/s/<token>/`.
// - A request carrying a Cloudflare header (`cf-connecting-ip` / `cf-ray`) came through the tunnel. The
//   tunnel's cloudflared connects from 127.0.0.1, so the remote address cannot tell host and collaborator
//   apart; these headers can. Cloudflare's edge always sets them and a client cannot remove them.
// - Host / Origin check against DNS rebinding and cross-site requests: only the loopback names (with our
//   port) and the active tunnel hostname are accepted.
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Header carrying the host secret on host-only HTTP calls. */
export const HOST_SECRET_HEADER = 'x-bpmn-edit-host';
/** Query parameter carrying the host secret (page URL printed by the CLI, WebSocket handshake). */
export const HOST_SECRET_PARAM = 'host';

/** Host secret: 256 bits, base64url (43 characters). */
export function newHostSecret() {
  return randomBytes(32).toString('base64url');
}

/** Session token: 192 bits, base64url (32 characters). */
export function newSessionToken() {
  return randomBytes(24).toString('base64url');
}

/** Shape of a session token in a URL (anything else is not even compared). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** Constant-time comparison of two strings; false unless both are non-empty strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True if the request came through the Cloudflare tunnel (has a Cloudflare edge header). */
export function isRemoteRequest(headers) {
  return headers['cf-connecting-ip'] !== undefined || headers['cf-ray'] !== undefined;
}

/** Loopback Host values accepted for our port. */
function localHosts(port) {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

/**
 * True if the Host header names this server: a loopback name with our port, or the active tunnel's
 * hostname (optionally with :443). Anything else (another name resolving to 127.0.0.1, i.e. DNS
 * rebinding; a missing Host) is refused.
 */
export function hostAllowed(host, { port, tunnelHost = null }) {
  if (typeof host !== 'string' || !host) return false;
  const value = host.trim().toLowerCase();
  if (localHosts(port).includes(value)) return true;
  if (!tunnelHost) return false;
  const tunnel = tunnelHost.toLowerCase();
  return value === tunnel || value === `${tunnel}:443`;
}

/**
 * True if the Origin header (if any) is one of our own pages: http://<loopback>:<port> or
 * https://<tunnel host>. No Origin (same-origin GETs, non-browser clients) is fine; "null" and every
 * other site is refused, so other web pages cannot drive the API or open a WebSocket.
 */
export function originAllowed(origin, { port, tunnelHost = null }) {
  if (origin === undefined) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false; // exactly scheme://host[:port], as browsers send it
  if (url.protocol === 'http:') return localHosts(port).includes(url.host);
  if (url.protocol === 'https:') return Boolean(tunnelHost) && url.host === tunnelHost.toLowerCase();
  return false;
}

/**
 * Splits a share path: `/s/<token>/<rest>` -> { token, rest: '/<rest>' }; `/s/<token>` (no slash) ->
 * { token, rest: null } (to be redirected); anything else -> { token: null, rest: pathname }.
 */
export function splitSharePath(pathname) {
  const match = /^\/s\/([^/]*)(\/.*)?$/.exec(pathname);
  if (!match) return { token: null, rest: pathname };
  return { token: match[1], rest: match[2] ?? null };
}
