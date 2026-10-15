# bpmn-edit — implementation plan

Source spec: `bpmn-edit.md`. Work is split into small **vertical slices**: each step ends with something a
real user can do, so it can be verified end to end.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done (verified)

## Definition of "verified"

A step is marked `[x]` only after a verifier agent has done an **end-to-end check as a user would use it**:

- start the real CLI (`node bin/bpmn-edit.js <file>` — and `npx` from a packed tarball in the final step),
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
  - `bin/bpmn-edit.js <file> [--port] [--no-open]`, `src/server.js` (node:http, static `web/`, `GET /api/file`),
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

- [x] **S3. External edits show up in the browser**
  - Carry-over from S2: add a session method for external replacement (bump version, origin = disk). Use
    `store.isOwnWrite()` / `lastWrite` for self-write suppression. macOS `fs.watch` emits 2× rename + a temp-file
    event per atomic write, so ignore `TEMP_FILE_RE`.
  - `chokidar` watch; self-writes suppressed; external change → bump version → push XML to clients, which
    re-import preserving viewport.
  - **E2E:** with the page open, modify the file on disk (as an IDE would); the browser shows the change without
    reload; no write-back loop (file mtime stable afterwards).

- [x] **S4. Live sync between several browser windows**
  - Carry-over from S3: broadcast client-origin changes via `remote-update` (today only disk-origin). Reuse the
    client's `deferredUpdate` + "local activity" check (unacked edits, label editor, drag). Must also fix: a tab
    whose first render failed stays blank when another tab repairs the file. Switch Playwright to real Chrome
    (`channel: 'chrome'`).
  - Broadcast updates to all other clients (last-write-wins, monotonically increasing version), echo-loop
    suppression, viewport/selection preserved on remote import.
  - **E2E:** two (and three) browser contexts on the host URL; create/move/delete in A → appears in B and C and
    on disk; edits from B reach A. Note observed latency/conflict behaviour (open question: full-XML vs ops).

- [x] **S5. Connected-users list** (verified 2026-10-13, incl. collaborators via share link)
  - Random friendly name + colour per client, editable (stored in `localStorage`); join/leave broadcast.
  - **E2E:** two windows both show 2 users; renaming in A updates B; closing A removes it from B.

- [x] **S6. Remote selection highlighting** (verified 2026-10-13)
  - `selection.changed` → send ids; others `canvas.addMarker(id, 'remote-sel-<n>')` with per-user colour; cleared
    on deselect/leave.
  - **E2E:** select a task in A → outlined in A's colour in B; deselect / close A → marker gone.

- [x] **S7. Share via public link** (verified 2026-10-13: real tunnel E2E, 3 verifier rounds, HAPPY)
  - Tunnel internals done & verified on branch `worktree-agent-acd048da3da9a5c58` (commit "Add cloudflared
    quick-tunnel module"); merge it first. Wiring notes: CLI SIGINT/SIGTERM must call `tunnel.stop()` (only an
    `exit` hook exists); surface `TUNNEL_RATE_LIMITED` in the Share UI (Cloudflare limits quick tunnels per IP —
    keep live-tunnel E2E runs few, `retries: 0`); tunnel e2e must open `/s/<token>`; Host check must accept the
    tunnel host; show download/startup progress on the spinner (startup 7–13 s); add a timeout to the binary
    download fetch.
  - `src/tunnel.js`: find `cloudflared` on PATH or download platform binary to `~/.bpmn-edit/bin/`; spawn
    quick tunnel, parse `*.trycloudflare.com` URL; provider interface. Host-only `POST/DELETE /api/share`;
    security model above. UI: Share → spinner → URL + Copy; Stop sharing. Share button hidden for collaborators.
  - **E2E (real tunnel):** click Share in the host window; a `https://…trycloudflare.com/s/<token>` URL appears;
    open it in a second browser context → the diagram loads and edits sync both ways and reach disk. Through the
    public URL: wrong token → 404, `/api/share` → 404, host page without secret → no host powers.
  - Carry-over from S1: add a Host/Origin header check (DNS-rebinding protection; accept localhost/127.0.0.1/[::1]
    and the active tunnel hostname only). Also: a wildcard `*:3000` listener elsewhere doesn't trigger port
    fallback. Detect it and fall back.

- [x] **S8. Session ended / stop sharing / reconnect** (verified 2026-10-13, real tunnel idle 160 s OK)
  - From Q3 (v1 requirement): through the tunnel an idle WebSocket is cut after exactly ~125 s (close 1006).
    Server must send a keepalive (e.g. ping every 30 s) and the client must auto-reconnect + re-sync.
    **E2E:** a socket idle > 125 s through a *real* tunnel stays connected (or recovers transparently).
  - Stop sharing → collaborators disconnected, old link 404. Host Ctrl-C → collaborators get "Session ended"
    overlay. Transient drop → "Reconnecting…" banner with backoff and re-sync.
  - **E2E:** collaborator window via the public link; Stop sharing → overlay, reload of old link fails;
    re-share gives a new link that works; Ctrl-C the CLI → overlay in collaborator; restart scenario for reconnect.

- [x] **S9. Ship it: `npx bpmn-edit`** (verified 2026-10-13: tarball install + npx, fresh cloudflared download, real share)
  - README (usage, sharing, security notes, bpmn.io license/watermark). LICENSE. `files` whitelist.
  - **E2E:** `npm pack`; install the tarball into a fresh temp dir; `npx bpmn-edit flows/order.bpmn` from a fresh
    git repo opens the browser editor (use `--no-open` + Playwright), edit → on disk, Share → public link works.
    Full `test/e2e` suite green.

- [x] **S10. Browser matrix: Firefox + WebKit** (verified 2026-10-13: 79 pass / 2 skip / 0 fail in each browser) (after S9; v1 support stays Chrome-only)
  - Add Firefox and WebKit as Playwright `projects` so **every** E2E spec automatically runs in all three
    browsers (no per-test opt-in). Fix or explicitly `test.skip` (with reason) anything browser-specific.
  - **E2E:** `npm run test:e2e` runs the whole suite × 3 browsers; Chrome must be green; Firefox/WebKit results
    reported, failures triaged into fix-now vs documented known issues.

- [x] **S11. Rename to `bpmn-edit`** (verified 2026-10-14: 3 browsers green, tarball + `npx bpmn-edit` + real share)
  - Former name local-bpmn; env vars now `BPMN_EDIT_*`, cache `~/.bpmn-edit/`, header `X-Bpmn-Edit-Host`, version
    1.0.0, repo/homepage/bugs → DreadBoy/bpmn-edit. npm note: `bpmn-edit@0.0.1` existed in 2021 (unpublished
    2022-01-07); 1.0.0 is free, 0.0.1 can never be reused.

- [x] **S12. Release via GitHub Actions** (after S11 and Q4-impl) — workflows ready; first manual publish + trusted
  publisher config pending owner (see docs/release-procedure.md "Owner steps").
  - Modelled on DreadBoy/glyphmark: `release.yml` (push to main → check: `npm ci` + unit tests → publish if the
    version is not on npm, npm Trusted Publishing/OIDC, provenance, Node 24) and `version.yml` (manual bump →
    dispatch Release). E2E stays local (needs macOS + real Chrome + tunnels).
  - Done 2026-10-14: history rewritten to author **and** committer `Matic Leva <vertical3life@gmail.com>`
    (no work email anywhere; no Co-Authored-By / "Generated with" / @-mentions); repo public, main pushed at bd340b7.
  - Product owner: configure trusted publisher on npmjs.com (`dread_boy`); the very first publish may have to be
    manual if npm requires the package to exist first (check). Push to https://github.com/DreadBoy/bpmn-edit
    only on explicit go-ahead.
  - Done: `.github/workflows/release.yml` (check on `macos-latest`: `npm ci`, unit tests, vendor drift check;
    publish on `ubuntu-latest` with OIDC, npm >= 11.5.1 guard, `npm view` no-op guard, no install/build) and
    `version.yml` (plain X.Y.Z greater than current, `npm version --no-git-tag-version`, commit as the dispatching
    actor's noreply address, dispatch Release). Verified locally: actionlint+shellcheck clean, `act -n` (0.2.89),
    probe/guard/bump scripts, `npm pack` (34 files, 426 kB) installed from tarball and smoke-tested in Chrome.
  - No CI e2e for now (decision in docs/release-procedure.md); follow-up: non-blocking macOS workflow with
    `BPMN_EDIT_SKIP_TUNNEL_E2E=1 npx playwright test --project=chrome`, measured on GitHub before gating.

## v2 (scope fixed 2026-10-15 by product owner: V2-1, V2-2, V2-3 only; everything else is v3)

v1 shipped: 1.0.0 (2026-10-14, manual publish of d305f2a) and 1.0.1 (2026-10-15, via release.yml with
provenance; adds the Q4 minimal-diff writer).

- [x] **V2-1. Create a new file.** Requested by product owner 2026-10-14; v1 refuses a missing path.
  Verified 2026-10-15: real pty prompt (y/yes/n/empty/Ctrl-C/Ctrl-D), non-TTY exits 1 fast, --create new/existing
  (byte-identical), refusals, appear-during-prompt race (no overwrite), Chrome edits saved mode=minimal and reopen;
  unit 311/311, Chrome e2e 184 passed / 2 skipped.
  - Missing path, interactive terminal (stdin and stdout are TTYs): ask `new.bpmn does not exist. Create it? [y/N]`.
    On yes, write a blank diagram (one start event, like the bpmn.io demo) and open it. On no or Ctrl+C, exit 1.
  - Missing path, not interactive (scripts, CI, piped): don't block. Print an error telling the user to pass
    `--create`, and exit 1.
  - `--create`: create without asking. If the file already exists, open it unchanged.
  - Refuse when the parent folder doesn't exist or the name doesn't end in `.bpmn`; never create folders.
    Create atomically and don't overwrite (`wx`).
  - Why: the prompt catches typos (`oder.bpmn`) without making the common case verbose, and the flag keeps
    scripts working. Both are a few lines in `bin/bpmn-edit.js` (`node:readline`); the e2e test drives a real
    TTY via a pseudo-terminal (e.g. `script -q`), or tests the non-TTY branch plus `--create`.

- [x] **V2-2. User-facing README.** Requested by product owner 2026-10-15. The current README (243 lines) mixes
  usage with internals (side-file names, race handling, host secret, grace periods).
  - Keep in README only what a user needs: what it is (one paragraph + screenshot), install/run, sharing in
    plain words, what happens to your file (auto-save, git-friendly diffs, edits from your IDE are merged), a short
    safety note, short known limitations, license.
  - Move the technical detail, unchanged, to `docs/how-it-works.md` and link it. No information is dropped.
  - Verify: a fresh reader with no project context follows the README from scratch (`npx bpmn-edit`) and gets
    to editing and sharing without opening any other file; every technical fact removed exists in the docs file.
  - Done: README rewritten for users (hero animation, requirements,
    install/run + options incl. `--create`, creating a file per V2-1, sharing, what happens to your file incl.
    side files, safety, short limitations, link to the project page and docs, license + watermark). All old
    technical text moved nearly verbatim to `docs/how-it-works.md` (plus V2-1 details: TTY rule, exit 1, `wx`).
    Media in `docs/images/` (not in the npm package, checked with `npm pack --dry-run`): `hero.gif` (1200 px,
    ~15 s, 0.7 MB; real CLI output with the host secret shown as `?host=…`, then real Chrome editing via
    Playwright screencast), `hero.mp4` + `hero-poster.png` for V2-3, `editor.png`, `share.png` (stand-in tunnel
    `BPMN_EDIT_TEST_TUNNEL=fake`, no real tunnel URL shown), `git-diff.png` (real `git diff` after a UI rename).
    Capture scripts kept in scratch (not in the repo).
  - Verified 2026-10-15 (fresh verifier, round 1, HAPPY): packed tarball run via npx in a fresh repo, real
    Chrome: start line, auto-save, one-line diff, `--port` fallback, `-V`/`-h`/`--no-open`, local share
    (fake tunnel) with presence/sync/stop; every removed fact found in `docs/how-it-works.md`; links, anchors and
    image paths resolve; media real, legible, no secrets; tarball has no images. `--create`/`[y/N]` not
    verifiable until V2-1 lands. Release order: push this README to main only together with V2-1 and after Pages
    is enabled (it documents `--create` and links the Pages URL).

- [x] **V2-3. Project web page on GitHub Pages.** Requested by product owner 2026-10-15.
  - One static page in `site/` (plain HTML/CSS, no build step), deployed by a `pages.yml` workflow
    (`actions/upload-pages-artifact` + `actions/deploy-pages`) on pushes that touch `site/`. Not `/docs`, which
    holds internal notes.
  - Content: tagline, short screen recording or screenshots (editing, live share with two cursors, clean git
    diff), `npx bpmn-edit file.bpmn`, features, how sharing works and is secured (plain words), links to npm and
    GitHub. Copy shares wording with the V2-2 README.
  - Owner step: repo Settings → Pages → Source "GitHub Actions" (one time). Then set the repo's website field
    and `homepage` in package.json to the Pages URL (ships with the next release).
  - Verify: page renders in Chrome, Firefox and WebKit at desktop and phone width, no console errors, all links
    resolve, Lighthouse accessibility ≥ 95; workflow passes actionlint; after the owner enables Pages, the live
    URL serves it.
  - Done: `site/index.html` + `style.css` + `main.js` (copy button with aria-live status, hero video autoplay
    only without prefers-reduced-motion, native controls) + `favicon.svg`; media in `site/media/` (hero.mp4,
    WebP poster/screenshots with 800/900 px variants, JPEG poster for og:image), ~400 KB total, system fonts, no external requests. Light
    and dark via prefers-color-scheme; sharing steps drawn as a small BPMN process (start event → tasks → end
    event), vertical on phones. `.github/workflows/pages.yml` (checkout@v6, configure-pages@v6,
    upload-pages-artifact@v5 with `path: site`, deploy-pages@v5; actionlint clean). `homepage` in package.json
    set to the Pages URL; `npm pack --dry-run` has no `site/`. Self-check (Chrome, Firefox, WebKit at 1280 and
    375 px, light and dark): no console errors, no horizontal scroll, images load, copy puts the command on the
    clipboard; Lighthouse (desktop and mobile) accessibility 100, best practices 100, SEO 100. The docs link
    (`docs/how-it-works.md` on main) 404s until V2-2 is pushed.
  - Verified 2026-10-15 (fresh verifier, round 1, HAPPY; then targeted wording fixes re-checked): Chrome, Firefox,
    WebKit at 1280/375 light+dark, no console errors/failed requests/horizontal scroll, copy button, keyboard +
    skip link, reduced motion; all links resolve (docs link after push); Lighthouse a11y 100 desktop+mobile;
    actionlint clean; no secrets in media. Live URL check pending the owner enabling Pages (Source: GitHub Actions).

- [x] **V2-4. Sharing first (README, page, hero).** Requested by product owner 2026-10-15. The main purpose is
  local files plus collaboration, so sharing leads everywhere.
  - Page: "What it does" starts with Edit in the browser, Live sharing, Nothing for your collaborators to set up;
    the rest reordered and tightened; tagline, sub-tagline, hero and section order put sharing first.
  - README: sharing in the intro under the hero; Sharing section directly after install/run; new-file text
    matches the real V2-1 messages in `bin/bpmn-edit.js`.
  - New hero GIF + MP4 (~20–25 s, real CLI + real editor, stand-in tunnel): command and output, editor opens,
    Share and link, collaborator window side by side, both in the users list with coloured selections, the
    collaborator's edit appears live in the host window, "Saved". Host secret, share token and tunnel hostname
    masked. GIF < ~5 MB and legible. Poster (webp) and og:image (jpg) regenerated in `docs/images/` and
    `site/media/`. No light-grey frame (fixes the dark-mode slab nit). Alt/aria texts updated.
  - Self-check: frames have no secret/token; page in Chrome at 1280/375 px light+dark, no horizontal scroll, no
    console errors; Lighthouse a11y ≥ 95; `npm pack --dry-run` has no docs/ or site/.
  - Done: page tagline "Edit your .bpmn files together, live.", lede leads
    with Share; hero text and recording side by side on wide screens; sections: hero → Sharing step by step →
    What it does (Edit in the browser, Live sharing, Nothing for your collaborators to set up, then the rest,
    tightened) → security → git diffs → requirements. README: sharing in the intro, Quick start → Sharing →
    Requirements → Options → Creating a new file (exact V2-1 messages; how-it-works gets the exact messages and
    the stdin/stdout/stderr TTY rule). New hero (21.6 s, 960×864, two windows stacked: host above, terminal
    then collaborator below; real CLI + Chrome via screencast, stand-in tunnel): `docs/images/hero.gif` 0.86 MB
    (15 fps), `hero.mp4` 0.28 MB in docs/images and site/media, posters (png, webp, 1200×630 jpg og:image).
    Host secret shown as `?host=…`; the share link is masked inside the page before it is ever drawn
    (`https://<random>.trycloudflare.com/s/…`), also in the terminal; the token never reaches a frame. No grey
    margin (frames are the dark terminal or the white editor). Self-check: Chrome 1280/375 light+dark, no
    horizontal scroll, no console errors; Lighthouse mobile+desktop a11y/best practices/SEO 100;
    `npm pack --dry-run` 37 files, none from docs/ or site/.
  - Verified 2026-10-15 (fresh verifier, round 1, HAPPY): tarball via npx in a fresh repo, real Chrome: edit,
    one-line diff, local share (fake tunnel) with presence and a collaborator rename live in the host in ~0.3 s;
    new file via real TTY prompt (y / n / Enter), non-TTY error and `--create`, messages match README and docs;
    no fact lost; hero storyboard holds, OCR over 216 frames + byte scan show no secret/token/hostname; page in
    Chrome/Firefox/WebKit 1280/375 light+dark clean, item order exact, Lighthouse a11y 100, links 200,
    actionlint clean. Nits to v3.

## v3 (deferred 2026-10-15 by product owner: all known issues and residuals below)
- V2-2/V2-3/V2-4 residuals (nits): `share.png`/`share.webp` context pad clips the "Order rejected" label and the
  link shows the stand-in hostname `test-….trycloudflare.com/s/…` (token cut off; unlike the hero's masking);
  hero windows are stacked rather than side by side; on wide screens the page's two-column hero shows the video
  at ~504 CSS px (toolbar text ~6 px at 1×; wider media column would help); hero editor crop hides the pool/lane
  labels and top lane; paused video's native controls cover the bottom of the poster (reduced motion).
- V2-1 residuals (minor, none loses or overwrites data):
  - Dangling symlink: `ln -s /nonexistent/t.bpmn dang.bpmn; bpmn-edit dang.bpmn` prompts "does not exist. Create
    it?" and after `y` (or with `--create`) fails with `File not found: dang.bpmn`. Nothing created; refuse up front
    with "is a broken symlink".
  - Trailing slash: `bpmn-edit --create slash.bpmn/` says `cannot create slash.bpmn/ (ENOENT)` without the reason.
  - Prompt and `created` line show the path as typed (e.g. a long absolute path), not just the file name.
  - File appearing while the prompt waits is opened silently; a short "appeared meanwhile, opening it" notice
    would be friendlier.
  - README startup paragraph still begins "The file must exist and be a regular file" (fold into V2-2 wording).
  - Ctrl-C typed before readline takes the terminal (keys buffered before the prompt) could leave the prompt
    waiting; seen only with scripted input arriving instantly.
- Q4-impl residuals (none loses data silently; fallbacks report what they drop):
  - Reported `format` fallbacks (low): editing documentation/condition text that holds a comment or CDATA, or a
    text annotation with an inline comment (`lost=` names it; for CDATA the output is still a 3-line diff);
    namespace declared on a sub-process and used by a child moved out/wrenched ("unbound prefix", `lost=1`);
    appending inside a collapsed sub-process of a bpmn-js 7 file (bpmnio-demo-export, ~880 lines, README limit).
  - CR inside element text (API/paste only, e.g. `updateLabel(annotation, "x\r\nz\rw")`) is written as the file's
    line end; reopen reads `\n` (low; attribute values already write `&#9;/&#10;/&#13;`).
  - An exception inside a modeling command (API misuse, e.g. `modeling.updateLabel(undefined, …)`) wedges the
    commandStack: later edits are never sent and the status keeps "Saved" (outside Q4, not reachable via UI).
  - Label cut on a tag-changing wrench where bpmn-js re-creates the shape without a label (Bizagi/Signavio task →
    user task): reported as `lost=1` (label style) on every such wrench; could keep the label instead.
  - Diff noise, model correct: new numbers `315` where the file spells `295.0`; empty element body left when all
    references go; DI shape id changes on wrench; restored element's DI id/label re-measured after undo;
    incoming/outgoing re-ordered on undo; wrench undo appends re-added attributes at the end of the tag; re-created
    label Bounds in bpmn-js attribute order; `xmlns:xsi` left on root after conditional start + undo; content shapes
    of a collapsed→expanded sub-process land after its shape; select-all delete + undo moves the process' leading
    comment to the end, and a free comment between cut elements stays put while they go back before it; empty
    `laneSet` after undo of pool+lane; `name=""` after undoing a label edit on an unnamed element; bpmnio-demo
    select-all delete + undo comes back in bpmn-js order and adds bpmn-js ≥ 9's separate diagrams for collapsed
    sub-processes.
- Linux: the server cannot start (found in S12). `wildcardListenerOn()` in `src/server.js` binds `0.0.0.0`/`::` with
  `exclusive: true` after our own loopback binds; Linux answers EADDRINUSE, so every port looks taken ("No free port
  found"); unit tests fail/hang there. Fix: skip the probe on Linux (redundant there — a loopback bind already fails
  next to a foreign wildcard listener). Out of v1 scope; then the Release `check` job can move to ubuntu.
- Q2 residuals: unsent edit lost if a disk change lands and the window closes before it is sent (host never
  overwrites); IDE temp+rename landing in the ~2 ms check-to-rename gap of the final Ctrl-C write is overwritten
  (~1/70); stale-save detection only within 5 s of our write chain, and not after exit; deliberate revert within 5 s
  gives notice + side file; element comparison literal on entities/CDATA/prefixes; SIGKILL loses accepted-unwritten
  edits; notice tooltip no longer hoverable (pointer-events none); `.bpmn-edit-replaced-*` link left on Ctrl-C
  within 2 s of replacing a broken file.
- S10 residuals: load-sensitive timings (s2 coalescing failed once at load ~150, q1 limits, WebKit s5 at 90 s);
  WebKit-only "network connection was lost" filter in s8 drop tests; fixed 20 px `#users` height clips with larger
  min font size; icon font now a separate 13 KB request (icons may appear late over a slow tunnel).
- Product note (2026-10-13): devs bookmark `localhost:<port>`; a bookmarked plain tab can edit but not share.
  Accepted for now (the CLI opens the host tab; `--port` is enough, no env var wanted). Possible later polish:
  host cookie (HttpOnly, SameSite=Strict) set by the printed link so any localhost tab in that browser can share.
- S9 residuals: README race text must be updated when Q2 lands, formatting-churn paragraph after Q4-impl;
  downloaded cloudflared not checksum-verified (documented); full-XML per edit (~107 KB on 304 elements) not in
  README; not published to npm (name `bpmn-edit` free as of 2026-10-13).
- S8 residuals: Share button enabled while reconnecting ("Failed to fetch"); dead share URL + controls still
  visible behind "Session ended" overlay; user re-added at end of list if keepalive evicts before reconnect;
  hidden tabs detect dead connection only after ~2 min (timer throttling); >10 MB update (1009) resent on every
  reconnect; crashed host via tunnel ends via 10 s 530 rule; reconnect banner not layout-tested at narrow widths;
  two negative checks use 1.5 s `waitForTimeout`.
- S5/S6 residuals: half-open connections stay listed until S8 keepalive; same-profile tabs share name/colour;
  colour collisions possible (stored colour not deduped, >8 users repeat); own+remote selection on same element
  shows remote colour; two remotes on one element show one colour; other users' dots not keyboard-focusable;
  narrow-toolbar truncations (share progress text at ~640px, file name 721–760px while sharing); Shift+Tab out of
  rename field may land on body.

- S7 residuals: only the tab opened from the printed URL is host (plain localhost tab can edit, not share);
  Ctrl-C during tunnel startup SIGKILLs cloudflared via exit hook, interrupted download leaves `.cloudflared-*`
  temp dir; reloaded host page re-shows last share error; failed Share logs 429/502 in console;
  `scripts/measure-tunnel.js` must share via `/api/share` before Q3 can be re-measured; a few negative UI checks
  use `waitForTimeout` before `toBeHidden()` (s7-share.spec.js:69/:200, s7-share-tunnel.spec.js:112).

- Startup accepts a truncated file (`looksLikeBpmn` only); use `isCompleteBpmn` like the watcher. (S3)
- Notice "showing the last good version" is wrong in a tab with nothing rendered. (S3)
- Failed import → re-import of last good XML resets undo history. (S3)
- `POST /api/file` → 404 instead of 405; raw EACCES message. (S1)

## Execution order (updated 2026-10-13 by product owner)

Public link proves the MVP, so S7 moves up: **S4 → Q1 (in progress) → S7 → S5 → S6 → S8**, then Q2, Q4-impl,
Q3 wrap-up, S9, S10. Quality over speed: verified properly, no rushing.

v2 order (2026-10-15): **V2-2 README → V2-3 web page → V2-1 create file**, released as 1.1.0. Verify
loops: at most a few rounds, then triage (only silent data loss or a broken release blocks).

## Parallelisation

Slices touch the same files (`server.js`, `app.js`), so they run mostly sequentially. Exception: the tunnel
module internals of S7 (`src/tunnel.js`: binary resolution/download + URL parsing) can be built in parallel with
S4–S6 in a separate worktree, then wired up and E2E-verified as S7.

## Open questions → measure-and-decide steps

The spec's open questions can't be answered up front; they depend on observed behaviour. Each one is a
step: measure with a reproducible E2E experiment, record numbers + decision in `docs/decisions.md`, and
implement the decision if it changes anything. These steps are as mandatory as the feature steps.

- [x] **Q1. Full-XML vs operation-level sync** (after S4, before S5)
  - Experiment: Playwright with 2 and 3 concurrent browser windows on (a) the small fixture and (b) a large
    generated diagram (~300 elements). Measure: edit-to-visible latency in other windows (p50/p95), WS payload size
    per edit, lost edits when two users edit *different* elements within the same ~500 ms, UX glitches on remote
    import (viewport jump, lost selection, interrupted drag/label edit in the receiving window).
  - Decide: keep full-XML for v1, or switch to op-level. Thresholds to apply: lost edits on *different* elements
    or an interrupted in-progress edit in the receiver is a defect → must be fixed (op-level or smarter merge);
    latency p95 > 500 ms on the large diagram → switch to op-level.
  - Record measurements + decision; if the decision is "change", add a new implementation step to this plan
    right after Q1 and do it (E2E-verified) before S5.

- [x] **Q2. Collaborator edit racing an external IDE save** (verified 2026-10-14; merged with S7/S8/S10, all 3 browsers green)
  - Experiment: E2E — browser edit and an on-disk write of a different change within the debounce window, both
    orders. Observe what ends up on disk and in each window; is anything silently lost?
  - Known from S3: an external save landing <~150 ms (settle delay) before the host writes a pending UI edit, or
    just before Ctrl-C flush, is overwritten silently. Candidate fix: re-check disk (mtime/size vs last write) right
    before each write and before shutdown flush. LWW is visible only on stderr/console today.
  - Decide policy (e.g. last-write-wins + visible "file changed on disk, your edit was overwritten" toast, or
    pause-and-ask). Record in `docs/decisions.md`, implement, E2E-verify the chosen behaviour.

- [ ] **Q4. Noisy first `git diff` (formatting churn)** (after S3)
  - **Measured** (branch `worktree-agent-add099222bc18c4f9`, `docs/q4-diff-churn.md`, verified on 12 real-world
    fixtures in `test/fixtures/q4/`): first save of a one-word rename produces 3–898 unrelated diff lines; later
    saves ≤1. **Silent information loss**: XML comments, processing instructions, DOCTYPE; a DOCTYPE entity gets
    corrupted to literal text. Recommendation: (c) server-side 3-way minimal-diff writer patching changed elements
    into the original text, verified against the bpmn-js model, falling back to (b) "preserve header/EOL/indent".
  - [x] **Q4-impl** — verified 2026-10-15 after 5 more fresh verify rounds (fixed: delete+undo restore, schema
    order from the BPMN XSD, extensions kept on every replace, size-bounded undo memory): unit 297/297, chrome/
    firefox/webkit 171 pass / 2 skip / 0 fail each, Q2 race ×3 green, ~2,500 UI + ~8,000 fuzz writes all
    `minimal` with no XSD regressions and no unreported loss. Residuals in v3 ("Q4-impl residuals").
  - (original acceptance) (after Q2; touches the write path). **E2E acceptance** over every file in `test/fixtures/q4`:
    one-label rename ≤1 unrelated line on first and later saves; zero information loss (comments, PIs,
    DOCTYPE/entities, CDATA, unknown extensions, prefixes, defaults, number spelling); EOL/indent/quotes/attr order/
    XML decl/final newline unchanged outside edited elements; 40 px move → no DI reordering, ≤16 lines; every write
    passes model check, 0 fallbacks on structural stress edits. Record decision in `docs/decisions.md`.
    Note: this machine has global `core.autocrlf=input`; Q4 branch adds `.gitattributes` (`*.bpmn -text`) so
    CRLF fixtures stay byte-exact. E2E test repos must set `core.autocrlf` explicitly (test both false and input).
  - Observed in S2: the first save rewrites the multi-line `<bpmn:definitions>` header onto one line (bpmn-js
    serialisation), so users see unrelated diff lines. Experiment: take BPMN files saved by Camunda Modeler,
    bpmn.io demo and a hand-formatted one; make one trivial edit through the UI; count diff lines unrelated to the
    edit. Decide whether to preserve original formatting (e.g. keep the original header / attribute order) and
    implement if the noise exceeds a handful of lines. Record in `docs/decisions.md`.

- [x] **Q3. Persistent session links across restarts** (decided: out of scope v1; decisions.md + README note done)
  - **Measured** (branch `worktree-agent-a32e37182302fa0cd`, `docs/q3-tunnel-measurements.md`, verified):
    startup ~7 s to first 200; HTTP stable 31 min; new hostname every share; old URL → 530/1033 immediately;
    named tunnels need a Cloudflare account + own domain. **Recommendation: out of scope for v1**; README must say
    each share/restart gives a new link. Remaining: merge branch, record decision in `docs/decisions.md`,
    README note (S9).
  - Experiment: what happens to a shared link when the host restarts the CLI or re-shares (quick tunnel gives a new
    hostname each time); how long quick tunnels take to come up and how stable they are over ~30 min.
  - Decide: confirm "out of scope for v1" (document the behaviour in README) or add a step for named tunnels.
    Record in `docs/decisions.md`.
