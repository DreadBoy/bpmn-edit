# local-bpmn — implementation plan

Source spec: `local-bpmn.md`. Work is split into small **vertical slices**: each step ends with something a
real user can do, so it can be verified end to end.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done (verified)

## Definition of "verified"

A step is marked `[x]` only after a verifier agent has done an **end-to-end check as a user would use it**:

- start the real CLI (`node bin/local-bpmn.js <file>` — and `npx` from a packed tarball in the final step),
- drive a **real browser** (Playwright, headless Chromium) against the running server: open the URL, click,
  drag, type, read what's on screen,
- observe real side effects (the `.bpmn` file on disk, a second browser window, the public tunnel URL).

Unit / integration tests are welcome as a means to an end, but **they never count as the final verification**.
Each step's E2E scenario is kept as an automated Playwright test in `test/e2e/` so later steps re-run all
earlier scenarios (regression).

## Scope of platforms (v1)

- **OS: macOS only.** Windows/Linux are out of scope for v1 (don't add Mac-only hacks gratuitously, but don't
  spend effort on other OSes).
- **Browser: Chrome only.** E2E runs Playwright against Google Chrome (`channel: 'chrome'`); Firefox/WebKit come
  in S10 as an automatic matrix.

## Ground rules

- Node ≥ 20, ESM (`"type": "module"`), no native deps.
- Layout from the spec: `bin/`, `src/`, `web/`, `web/vendor/`.
- No bundler at runtime; bpmn-js modeler vendored from its prebuilt `dist/` (committed in `web/vendor/bpmn-js/`).
- bpmn.io watermark must stay visible.
- Commits must not mention AI/Claude anywhere.

## Security model (enforced from S7 on)

Tunnel traffic reaches the server from `127.0.0.1` (cloudflared runs locally), so the remote address
cannot tell host and collaborator apart:

- **Host secret**: random token created at startup; the CLI opens `http://localhost:PORT/?host=<secret>`; the page
  sends it on host-only calls (`/api/share`) and on its WebSocket handshake.
- **Session token**: ≥128-bit base64url, created when sharing starts; collaborators use `/s/<token>`.
  Stopping the share rotates it and disconnects collaborators.
- Requests carrying Cloudflare headers (`cf-connecting-ip` / `cf-ray`) are remote: they need a valid session
  token and can never reach host-only endpoints. Wrong token / unknown path → 404.

---

## Steps

- [x] **S1. Open a diagram in the browser**
  - Scaffold `package.json` (bin, engines, `type: module`, `files`), deps `ws`, `chokidar`, `commander`, `open`,
    `bpmn-js`; dev `playwright`. `scripts/vendor.js` copies bpmn-js dist into `web/vendor/bpmn-js/`.
  - `bin/local-bpmn.js <file> [--port] [--no-open]`, `src/server.js` (node:http, static `web/`, `GET /api/file`),
    `web/index.html` + `web/app.js` (toolbar with file name + full-height canvas, renders the XML, fits viewport).
    Port fallback if busy. Clear error + non-zero exit for missing/invalid file.
  - Fixture `test/fixtures/order.bpmn`.
  - **E2E:** run CLI on a copy of the fixture with `--no-open`; open the printed URL in Chromium; the diagram's
    shapes/labels are visible, watermark present, no console errors. CLI with a bad path exits non-zero with message.

- [x] **S2. Edits are saved to disk**
  - Carry-over from S1: raise `engines.node` to `>=20.19` (chokidar 5 requirement) or pin chokidar 4. The server
    binds both 127.0.0.1 and ::1 (`httpServers`), so attach the WS `upgrade` handler to each.
  - `src/file.js`: debounced atomic write (tmp + rename), flush on exit. Client sends full XML on
    `commandStack.changed` (debounced) over WebSocket (`ws`); host keeps canonical XML + version.
  - SIGINT/SIGTERM: flush pending write, exit 0.
  - **E2E:** in the browser, add a task from the palette and rename it; within ~1 s the file on disk contains the
    new task; `git diff` shows it. Ctrl-C right after an edit still persists it.

- [ ] **S3. External edits show up in the browser**
  - Carry-over from S2: add a session method for external replacement (bump version, origin = disk). Use
    `store.isOwnWrite()` / `lastWrite` for self-write suppression. macOS `fs.watch` emits 2× rename + a temp-file
    event per atomic write, so ignore `TEMP_FILE_RE`.
  - `chokidar` watch; self-writes suppressed; external change → bump version → push XML to clients, which
    re-import preserving viewport.
  - **E2E:** with the page open, modify the file on disk (as an IDE would); the browser shows the change without
    reload; no write-back loop (file mtime stable afterwards).

- [ ] **S4. Live sync between several browser windows**
  - Broadcast updates to all other clients (last-write-wins, monotonically increasing version), echo-loop
    suppression, viewport/selection preserved on remote import.
  - **E2E:** two (and three) browser contexts on the host URL; create/move/delete in A → appears in B and C and
    on disk; edits from B reach A. Note observed latency/conflict behaviour (open question: full-XML vs ops).

- [ ] **S5. Connected-users list**
  - Random friendly name + colour per client, editable (stored in `localStorage`); join/leave broadcast.
  - **E2E:** two windows both show 2 users; renaming in A updates B; closing A removes it from B.

- [ ] **S6. Remote selection highlighting**
  - `selection.changed` → send ids; others `canvas.addMarker(id, 'remote-sel-<n>')` with per-user colour; cleared
    on deselect/leave.
  - **E2E:** select a task in A → outlined in A's colour in B; deselect / close A → marker gone.

- [ ] **S7. Share via public link**
  - `src/tunnel.js`: find `cloudflared` on PATH or download platform binary to `~/.local-bpmn/bin/`; spawn
    quick tunnel, parse `*.trycloudflare.com` URL; provider interface. Host-only `POST/DELETE /api/share`;
    security model above. UI: Share → spinner → URL + Copy; Stop sharing. Share button hidden for collaborators.
  - **E2E (real tunnel):** click Share in the host window; a `https://…trycloudflare.com/s/<token>` URL appears;
    open it in a second browser context → the diagram loads and edits sync both ways and reach disk. Through the
    public URL: wrong token → 404, `/api/share` → 404, host page without secret → no host powers.
  - Carry-over from S1: add a Host/Origin header check (DNS-rebinding protection; accept localhost/127.0.0.1/[::1]
    and the active tunnel hostname only). Also: a wildcard `*:3000` listener elsewhere doesn't trigger port
    fallback. Detect it and fall back.

- [ ] **S8. Session ended / stop sharing / reconnect**
  - Stop sharing → collaborators disconnected, old link 404. Host Ctrl-C → collaborators get "Session ended"
    overlay. Transient drop → "Reconnecting…" banner with backoff and re-sync.
  - **E2E:** collaborator window via the public link; Stop sharing → overlay, reload of old link fails;
    re-share gives a new link that works; Ctrl-C the CLI → overlay in collaborator; restart scenario for reconnect.

- [ ] **S9. Ship it: `npx local-bpmn`**
  - README (usage, sharing, security notes, bpmn.io license/watermark). LICENSE. `files` whitelist.
  - **E2E:** `npm pack`; install the tarball into a fresh temp dir; `npx local-bpmn flows/order.bpmn` from a fresh
    git repo opens the browser editor (use `--no-open` + Playwright), edit → on disk, Share → public link works.
    Full `test/e2e` suite green.

- [ ] **S10. Browser matrix: Firefox + WebKit** (after S9; v1 support stays Chrome-only)
  - Add Firefox and WebKit as Playwright `projects` so **every** E2E spec automatically runs in all three
    browsers (no per-test opt-in). Fix or explicitly `test.skip` (with reason) anything browser-specific.
  - **E2E:** `npm run test:e2e` runs the whole suite × 3 browsers; Chrome must be green; Firefox/WebKit results
    reported, failures triaged into fix-now vs documented known issues.

## Parallelisation

Slices touch the same files (`server.js`, `app.js`), so they run mostly sequentially. Exception: the tunnel
module internals of S7 (`src/tunnel.js`: binary resolution/download + URL parsing) can be built in parallel with
S4–S6 in a separate worktree, then wired up and E2E-verified as S7.

## Open questions → measure-and-decide steps

The spec's open questions can't be answered up front; they depend on observed behaviour. Each one is a
step: measure with a reproducible E2E experiment, record numbers + decision in `docs/decisions.md`, and
implement the decision if it changes anything. These steps are as mandatory as the feature steps.

- [ ] **Q1. Full-XML vs operation-level sync** (after S4, before S5)
  - Experiment: Playwright with 2 and 3 concurrent browser windows on (a) the small fixture and (b) a large
    generated diagram (~300 elements). Measure: edit-to-visible latency in other windows (p50/p95), WS payload size
    per edit, lost edits when two users edit *different* elements within the same ~500 ms, UX glitches on remote
    import (viewport jump, lost selection, interrupted drag/label edit in the receiving window).
  - Decide: keep full-XML for v1, or switch to op-level. Thresholds to apply: lost edits on *different* elements
    or an interrupted in-progress edit in the receiver is a defect → must be fixed (op-level or smarter merge);
    latency p95 > 500 ms on the large diagram → switch to op-level.
  - Record measurements + decision; if the decision is "change", add a new implementation step to this plan
    right after Q1 and do it (E2E-verified) before S5.

- [ ] **Q2. Collaborator edit racing an external IDE save** (after Q1)
  - Experiment: E2E — browser edit and an on-disk write of a different change within the debounce window, both
    orders. Observe what ends up on disk and in each window; is anything silently lost?
  - Decide policy (e.g. last-write-wins + visible "file changed on disk, your edit was overwritten" toast, or
    pause-and-ask). Record in `docs/decisions.md`, implement, E2E-verify the chosen behaviour.

- [ ] **Q4. Noisy first `git diff` (formatting churn)** (after S3)
  - Observed in S2: the first save rewrites the multi-line `<bpmn:definitions>` header onto one line (bpmn-js
    serialisation), so users see unrelated diff lines. Experiment: take BPMN files saved by Camunda Modeler,
    bpmn.io demo and a hand-formatted one; make one trivial edit through the UI; count diff lines unrelated to the
    edit. Decide whether to preserve original formatting (e.g. keep the original header / attribute order) and
    implement if the noise exceeds a handful of lines. Record in `docs/decisions.md`.

- [ ] **Q3. Persistent session links across restarts** (after S8)
  - Experiment: what happens to a shared link when the host restarts the CLI or re-shares (quick tunnel gives a new
    hostname each time); how long quick tunnels take to come up and how stable they are over ~30 min.
  - Decide: confirm "out of scope for v1" (document the behaviour in README) or add a step for named tunnels.
    Record in `docs/decisions.md`.
