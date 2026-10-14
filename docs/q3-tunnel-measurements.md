# Q3: Persistent session links across restarts — measurements

Question (PLAN.md, Q3): what happens to a shared link when the host restarts the CLI or re-shares, how long
quick tunnels take to come up, and how stable they are over ~30 minutes. Decide whether persistent links
(named tunnels) are in scope for v1.

## Setup

| | |
|---|---|
| Date | 2026-10-12, 23:09–23:44 UTC (one run) |
| Machine | Apple M1 Pro, macOS 26.6.2 (build 25G83), arm64; network egress via Cloudflare `LJU` / `lju01` |
| cloudflared | 2026.10.0 (built 2026-10-05), downloaded by `ensureCloudflared()` into a scratch cache (`--home`), not on PATH |
| Node | v22.22.2 |
| Browser | Google Chrome 155.0.8059.40, headless, via Playwright 1.64.0 (`channel: 'chrome'`) |
| Target | real CLI: `node bin/bpmn-edit.js <scratch copy of test/fixtures/order.bpmn> --no-open --port 3917` |
| Tunnel | `startTunnel()` from `src/tunnel.js` (Cloudflare quick tunnel, `retries: 0`, `timeoutMs: 90000`) pointed at the CLI's port. The CLI has no share flag/endpoint yet (S7 not wired), so the tunnel is started by the script, not through the UI. "Stop as a user would" = `tunnel.stop()` and SIGINT (Ctrl-C) to the CLI at the same moment, which is what the S7 wiring will do. |
| Script | `scripts/measure-tunnel.js` (default options: 31 min window, 20 s poll interval, 120 s old-URL probe, 150 s gap before tunnel #2, 60 s probe of tunnel #2's old URL). Dry-run first with `--local` (no tunnel). |
| Tunnels opened | **2** in the measurement run — #1 spawned 23:09:18.034Z, #2 spawned 23:42:56.748Z (33.6 min apart). No 429 / rate limiting seen. A separate, independent verification run opened one more tunnel at 23:47:51.866Z (its own script; log `docs/q3-tunnel-evidence/verify.jsonl`); it is reported as sample #3 below. |

Reproduce: `node scripts/measure-tunnel.js --out <dir> [--home <cloudflared cache dir>]` (~37 min, opens 2 tunnels).

## Results

### 1. Startup time (ms after cloudflared spawn)

| Tunnel | Hostname | URL printed | Authoritative DNS resolves | Tunnel ready (module) | System resolver resolves | First HTTP 200 (system resolver) |
|---|---|---|---|---|---|---|
| #1 | `follow-staff-royal-telescope.trycloudflare.com` | 5077 | 6148 | 6386 | 6403 | **6479** |
| #2 | `entire-most-invalid-differ.trycloudflare.com` | 4989 | 6548 | 6765 | 6779 | **6849** |
| #3 (verification run) | `dropped-forestry-chairs-signed.trycloudflare.com` | 5610 | 6674 | 6948 | — | **7054** |

Sample #3 comes from the independent verification run (`verify.jsonl`), which did not record a separate
system-resolver time. That run also received `init` over `wss://<host>/ws`. Its old URL returned 530 / 1033 on
every probe from 20 ms to 60 s after stop (7 probes).

- "Authoritative DNS" = `probeTunnelDns()` (the module asks trycloudflare.com's name servers) first returns an A
  record. "Tunnel ready" = first probe that is not a 530/1033. System-resolver lookup and the plain `fetch` were
  only started after "ready" (to avoid caching an NXDOMAIN), so those two columns are upper bounds that mostly
  reflect when they were tried; for #1 and #2 both succeeded on the first attempt
  (`startup-1-attempts.jsonl`, `startup-2-attempts.jsonl`: one HTTP attempt each, no DNS failures).
- `ensureCloudflared()` found the cached binary in 2 ms; download time is not included.
- About 5–5.6 s of each startup is cloudflared requesting the quick tunnel (#1: "Requesting new quick Tunnel"
  at +0.13 s → URL printed at +5.08 s); authoritative DNS appeared 1.1–1.6 s after the URL was printed.

### 2. Stability of tunnel #1 over 31 minutes

Window 23:09:25.677Z → 23:40:25.856Z (31.0 min), one GET of `/` every 20 s through the system resolver.

| Metric | Value |
|---|---|
| HTTP samples | 93 |
| Non-200 samples | **0** (all 200, all contained the editor shell `id="canvas"`) |
| Latency min / median / p95 / max | 33 / 79 / 101 / 233 ms (mean 82.7 ms) |
| cloudflared log during the window | no lines at all between the start-up pre-checks (23:09:29Z) and shutdown (23:40:26Z): no reconnects, no errors (runs with `ha-connections:1`, protocol `quic`) |
| Chrome load at start (23:09:25Z) | rendered: 13 shapes, 6 connections, all 7 labels, status "Saved", load 589 ms, no page errors (`browser-start.png`) |
| Chrome fresh load at end (23:40:26Z) | rendered: same counts, status "Saved", load 684 ms, no page errors (`browser-end.png`) |

**WebSocket (`wss://<host>/ws`), kept open by the script without sending anything (like an idle editor):**

| Metric | Value |
|---|---|
| Opens | 15 (1 initial + 14 reconnects) |
| Drops (not closed by us) | **14**, all close code **1006**, each after **125.08–125.12 s** open |
| Drop times | 23:11:30, 23:13:37, 23:15:44, … 23:39:03 (every ~127 s = 125 s idle + 2 s reconnect delay) |
| Connect time | initial open 71 ms; the 14 reconnects 116–181 ms |
| Server messages | `init` on every (re)connect (clientId c2…c16, version 1, 5650-char XML); `flush` once when the CLI was Ctrl-C'd; no WebSocket pings from the server |
| Errors | 0 |

The Chrome page kept open on the public URL for the whole window showed "Saved" for the first 7 samples and
**"Disconnected" from 23:11:45Z on** (86 of 93 samples), i.e. it lost its socket at the first ~125 s idle drop
and never reconnected (`browser-kept-open-end.png`; the current `web/app.js` has no reconnect, that is S8).
The diagram stayed visible but the page no longer synced.

### 3. Restart behaviour

**Stopping tunnel #1** (23:40:26.638Z; `tunnel.stop()` + SIGINT to the CLI): cloudflared exited with code 0 after
25 ms, the CLI exited 0. Probing the old URL every 10 s for 2 min (`old-url-1.jsonl`):

| Since stop | HTTP | Cloudflare error | DNS (system / authoritative) |
|---|---|---|---|
| 1.6 s | 530 | 1033 | resolves / resolves |
| 11.7 s … 112.6 s (11 more samples) | 530 every time | 1033 every time | resolves / resolves every time |
| 2 min 38 s (while tunnel #2 was up) | 530 | 1033 | resolves / resolves |

So the old link dies immediately (first probe 1.6 s after stop) but not with NXDOMAIN: the hostname keeps
resolving to Cloudflare (104.16.230.132 / 104.16.231.132) and the edge answers **HTTP 530, error 1033**
("Cloudflare Tunnel error") for at least 2.6 minutes. There is no redirect or hint to the new link.

**Restart** (tunnel #2, 150 s after stopping #1): new CLI process on the same file and port, new tunnel.

- Hostname: `entire-most-invalid-differ.trycloudflare.com` — **different** from tunnel #1
  (`follow-staff-royal-telescope.trycloudflare.com`).
- Startup: first HTTP 200 6849 ms after spawn (table above). Chrome load through it: rendered, 13 shapes, all 7
  labels, 512 ms, no page errors (`browser-tunnel2.png`).
- The Chrome page still open on the old link stayed "Disconnected": a collaborator on the old link has no way to
  reach the restarted session.
- Stopping tunnel #2: old URL returned 530 / 1033 from the first probe (55 ms after stop) through 50 s, DNS still
  resolving (`old-url-2.jsonl`, 6 samples).

### 4. Named tunnels: what a persistent link requires (Cloudflare docs, read 2026-10-13)

Quick tunnels (what `src/tunnel.js` uses), from [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
(formerly `developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/`):

- "Quick Tunnels are for testing and development." "For production, create a Cloudflare Tunnel."
- "Quick Tunnels have no uptime guarantee."
- "Each Quick Tunnel supports up to 200 in-flight requests." "Additional requests return a `429` response."
- "Quick Tunnels do not support Server-Sent Events (SSE)." (bpmn-edit uses WebSockets, which worked.)
- "The hostname changes each time you create a Quick Tunnel." "For stable hostnames and production traffic,
  create a Cloudflare Tunnel."
- "You do not need a Cloudflare account or domain." The URL stops working when the process stops.
- cloudflared itself prints that account-less tunnels have no uptime guarantee (`cloudflared-1.log`).

A stable hostname needs a named Cloudflare Tunnel. Two ways:

**Locally-managed** ([Create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/)):

1. Prerequisites: a Cloudflare account, a website (domain) added to Cloudflare with its nameservers changed to
   Cloudflare.
2. `cloudflared tunnel login` — browser login, pick the hostname/zone; writes the account certificate `cert.pem`.
3. `cloudflared tunnel create <NAME>` — tunnel UUID + credentials file `~/.cloudflared/<UUID>.json`
   (and a `<UUID>.cfargotunnel.com` subdomain).
4. `config.yml` with `url: http://localhost:<port>`, `tunnel: <UUID>`, `credentials-file: …`.
5. `cloudflared tunnel route dns <UUID or NAME> <hostname>` — CNAME `<hostname>` → `<UUID>.cfargotunnel.com`
   in the user's zone.
6. `cloudflared tunnel run <UUID or NAME>` (`--config <path>` for a non-default config).

**Remotely-managed / token-based** ([Get started](https://developers.cloudflare.com/tunnel/get-started/),
[Tunnel tokens](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/)):

1. Prerequisites: a Cloudflare account and a domain on Cloudflare ("required to publish applications").
2. Dashboard → Networking → Tunnels → Create Tunnel; add a route of type "Published application" with a
   subdomain on one of the user's domains and the service URL (e.g. `http://localhost:3000`).
3. The connector runs with only the token: "A remotely-managed tunnel only requires a token to run. Anyone with
   the token can run the tunnel." The docs show `cloudflared service install <TUNNEL_TOKEN>` and
   `cloudflared tunnel --no-autoupdate run --token <TUNNEL_TOKEN>` (Docker); the 2026.10.0 binary used here
   accepts `tunnel run --token` / `--token-file` / `$TUNNEL_TOKEN` (`cloudflared tunnel run --help`).

Either way the user needs a Cloudflare account and their own domain on Cloudflare; nothing about it can be done
for them by `npx bpmn-edit`. No account actions were taken for this experiment.

A stable hostname alone would not be enough: a link that survives a restart would also need the session token
in `/s/<token>` to persist across restarts (bpmn-edit.md, Open questions: "Whether to persist session tokens so
a restart keeps the same link").

Related, for the WebSocket drops above: Cloudflare's [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)
list a **Proxy Read Timeout of 125 s** (Cloudflare ↔ origin, 524, adjustable only on Enterprise zones). The page
does not mention WebSockets, so attributing the observed 125.1 s idle drops to this limit is an inference from
the matching number, not something the docs state.

## Observations

1. Every share/restart gives a new random hostname; the old one answers 530/1033 immediately and keeps
   resolving in DNS. A collaborator holding the old link sees a Cloudflare error page, not bpmn-edit.
2. Startup is about 6.5–7 s to a working public URL with a cached binary (three samples: 6479, 6849, 7054 ms),
   about 5–5.6 s of which is cloudflared obtaining the quick tunnel. This is at the low end of the 7–13 s noted
   in PLAN.md S7.
3. Plain HTTP over the quick tunnel was fully stable for 31 min: 93/93 200s, p95 101 ms, no cloudflared
   reconnects.
4. **Idle WebSockets through the tunnel are cut every ~125 s (close 1006).** The server sends no keepalive, and
   the current editor page does not reconnect, so a collaborator who is idle for ~2 minutes silently stops
   syncing ("Disconnected"). This is independent of persistent links but affects every shared session.
5. The measurement run opened 2 tunnels and the verification run 1; no rate limiting was hit. The 429 lockout
   seen earlier means live-tunnel tests must stay few, which also argues against a design that opens tunnels
   often.

## Recommendation

**Persistent links: out of scope for v1.** Document in the README that each Share (and each CLI restart) gives
a new link, that old links stop working immediately (Cloudflare error 1033), and that collaborators need the new
link.

Reasons from the data:

- The restart problem is inherent to quick tunnels (new hostname every time, old one 530/1033), and the only fix
  is a named tunnel, which requires the user to have a Cloudflare account, a domain on Cloudflare, a browser
  login (`cert.pem`) or dashboard token, and a DNS route — plus a session token that persists across restarts.
  That cannot be automated by `npx bpmn-edit` and is a separate, opt-in feature (e.g. a later
  `--tunnel-token` / `--hostname` option that runs `cloudflared tunnel run --token`), not something to block v1
  on.
- Within one CLI run, the quick tunnel's **HTTP** path was stable: up in about 6.5–7 s, 0 HTTP failures over
  31 min. The WebSocket path was not usable as-is over that time (observation 4), which is addressed by the
  requirement below, not by named tunnels.

**v1 requirement (acceptance criteria for S7/S8, not optional):**

- **Keepalive:** the server must send traffic on every WebSocket well under the observed 125 s idle cut, e.g. an
  application-level message (or at least a WebSocket ping) every 30 s. S7/S8 acceptance must include an E2E
  check that a socket left idle for more than 125 s through a real tunnel stays connected.
- **Client reconnect with re-sync (S8):** after a drop, the page must reconnect with backoff and re-sync the
  document; today one idle drop leaves the collaborator "Disconnected" for good.

Also for S8: a collaborator reloading an old link gets Cloudflare's 1033 page, which bpmn-edit cannot
customise; the README note above is the mitigation.

## Appendix: evidence

The raw logs are the `--out <dir>` of `node scripts/measure-tunnel.js --out <dir>`. The files below were copied
into `docs/q3-tunnel-evidence/`, with absolute local paths replaced by placeholders (`<out-dir>`,
`<cloudflared-home>`, `<scratch>`, `~`); nothing else was changed.

| File in `docs/q3-tunnel-evidence/` | Content |
|---|---|
| `events.jsonl` | timeline of the whole run (progress phases, tunnel up/stop, browser results) |
| `startup.json` | startup marks (ISO timestamps + ms) for tunnels #1 and #2 |
| `startup-1-attempts.jsonl`, `startup-2-attempts.jsonl` | system-DNS / HTTP attempts after "ready" |
| `poll.jsonl` | 93 stability samples (status, latency, cf-ray, kept-open page status) |
| `ws.jsonl` | WebSocket open/message/close events with timestamps and connect times |
| `browser.jsonl` | Chrome load results (start, end, kept-open page, tunnel #2) |
| `browser-start.png`, `browser-end.png`, `browser-kept-open-end.png`, `browser-tunnel2.png` | screenshots |
| `old-url-1.jsonl`, `old-url-2.jsonl` | probes of the stopped tunnels' URLs (HTTP + DNS) |
| `cloudflared-1.log`, `cloudflared-2.log` | cloudflared stdout/stderr with local timestamps |
| `summary.json` | computed statistics |
| `verify.jsonl` | independent verification run (tunnel #3 sample: startup marks, `init` over wss, old-URL probes) |

The run's `cli-1.log` / `cli-2.log` (CLI output and exit codes, both exit 0) and a `--local` dry run were not
copied.
