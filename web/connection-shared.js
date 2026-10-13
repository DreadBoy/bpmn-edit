// Connection rules shared by the host (src/server.js) and the editor page (web/app.js): close codes,
// keepalive timing and the page's reconnect policy. Plain functions, no DOM and no Node APIs, so the
// page loads it as a module and the unit tests import it directly.
//
// Close codes the host sends (anything else, including 1006 "connection lost without a close
// frame", is treated by the page as a transient drop and retried):
//   4001 'share-stopped'   collaborator socket whose link was revoked (Stop sharing)
//   4002 'session-ended'   the host is shutting down (Ctrl-C / SIGTERM)

export const CLOSE_SHARE_STOPPED = 4001;
export const CLOSE_SESSION_ENDED = 4002;

/**
 * The host pings every WebSocket this often (WebSocket ping frame) and drops a connection that has
 * not answered the previous ping. Through a Cloudflare quick tunnel an idle WebSocket is cut after
 * ~125 s (docs/q3-tunnel-measurements.md), so this has to stay well below that.
 */
export const KEEPALIVE_MS = 30_000;

/**
 * The page sends { type: 'ping' } this often and expects { type: 'pong' } (or any other message)
 * before the next one; otherwise it treats the connection as dead and reconnects. Browsers do not
 * expose WebSocket ping frames to the page, so this is how it notices a connection that died
 * without a close (network change, sleep).
 */
export const HEARTBEAT_MS = 30_000;

/**
 * Reconnect policy of the page after a transient drop:
 * - delays: wait before attempt n (1-based; the last entry repeats), each varied by ±jitter;
 * - give up ("Session ended") once at least giveUpAttempts attempts failed AND giveUpMs passed since
 *   the drop (both, so a laptop waking from sleep still gets a few attempts);
 * - a probe of the page's own `api/file` answering 404 means the link or session is gone: give up at
 *   once; 530 (Cloudflare: no tunnel for this hostname) for tunnelGoneMs in a row: give up too.
 */
export const RECONNECT = Object.freeze({
  delays: Object.freeze([500, 1000, 2000, 4000, 8000, 10_000]),
  jitter: 0.2,
  giveUpAttempts: 8,
  giveUpMs: 60_000,
  tunnelGoneMs: 10_000,
});

/** Shape of the per-page key a window sends in 'hello' (see src/presence.js). */
export const CLIENT_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Delay before reconnect attempt `attempt` (1-based), with jitter. */
export function reconnectDelay(attempt, policy = RECONNECT, random = Math.random) {
  const { delays, jitter = 0 } = policy;
  const base = delays[Math.min(Math.max(attempt, 1), delays.length) - 1];
  return Math.max(0, Math.round(base * (1 + jitter * (2 * random() - 1))));
}

/**
 * What the HTTP status of a probe of `api/file` says about the session (null = network error):
 * 'gone' (404: wrong token, sharing stopped, or a restarted host without this link),
 * 'tunnel-gone' (530: Cloudflare has no tunnel for this hostname), else 'retry'.
 */
export function probeVerdict(status) {
  if (status === 404) return 'gone';
  if (status === 530) return 'tunnel-gone';
  return 'retry';
}

/**
 * Whether to stop reconnecting. `state`: { attempts (failed so far), since (time of the drop),
 * tunnelGoneSince (first of the current run of 530 answers, or null) }.
 */
export function shouldGiveUp(state, now, policy = RECONNECT) {
  if (state.tunnelGoneSince !== null && state.tunnelGoneSince !== undefined
    && now - state.tunnelGoneSince >= policy.tunnelGoneMs) return true;
  return state.attempts >= policy.giveUpAttempts && now - state.since >= policy.giveUpMs;
}
