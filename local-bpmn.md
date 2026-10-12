# local-bpmn

A single `npx` command that opens a BPMN file from your repo in a browser-based editor, saves changes back to disk, and lets you invite collaborators with a link.

## Problem

- BPMN editing today means either a desktop app (Camunda Modeler) or an IDE extension (VS Code `bpmn-io`). Neither gives a zero-install, shareable editing session.
- Collaborators are often product people who will open a link but will not install tools, create accounts, or run terminal commands.
- The file should stay where it already lives: a `.bpmn` in a git repo, owned by the host.

## Product outline

### Host flow

```
npx local-bpmn flows/order.bpmn
```

1. Starts a local HTTP + WebSocket server (e.g. `localhost:3000`).
2. Opens the browser with the editor showing the file.
3. Every change is written back to the file on disk (debounced), so `git diff` shows the result immediately.
4. A **Share** button in the UI starts a tunnel and shows a public URL containing a session token, e.g. `https://xxxx.trycloudflare.com/s/9f3k2a`. Copy, send. Sharing is only ever started from the UI; there is no CLI flag for it.

### Collaborator flow

1. Open the link. No install, no account, no command.
2. Editor loads from the host's machine; the diagram is the host's current file state.
3. Edits sync live to the host and to all other collaborators. A connected-users list shows who is in the session; element-level selection highlighting is a small add-on (see Presence below).
4. If the host closes the session, collaborators see a "session ended" state. The file never lives anywhere but the host's disk.

### Scope (v1)

- Single file per session.
- Host is the only writer to disk; collaborators are clients of the host.
- Last-write-wins sync at the element-operation level (no CRDT).
- Share button in the UI; connected-users list.

### Out of scope (v1)

- CLI flags for sharing (`--share`, `--share-readonly`); read-only links.
- Multi-file / project view.
- Offline editing, persistence when host is down.
- True peer-to-peer (no third-party relay).
- Auth beyond the session token.

## Tech stack

### Editor (browser)

- **bpmn-js** (bpmn.io) — the modeler; MIT-style bpmn.io license (watermark must stay).
- **bpmn-js-properties-panel** — optional, for element attributes.
- Served as a static page; load bpmn-js from a vendored build or CDN so the package needs no bundling step at runtime.
- Sync hook: listen on `commandStack.changed` / `elements.changed`, serialize the change (operation + affected element ids + new XML or diff), send over WebSocket.

### Host process (Node, published to npm)

- **Node ≥ 20**, ESM, no native deps so `npx` is fast and cross-platform.
- **HTTP server**: `node:http` or Fastify/Hono — serves the editor, the file, and the share endpoint.
- **WebSocket**: `ws` — one room per session; broadcasts ops to all clients, applies to the host's in-memory model.
- **File I/O**: `node:fs` with debounced writes; `chokidar` to detect external edits (editor/IDE) and push the new XML to clients.
- **CLI**: `commander` or `citty`; `open` to launch the browser.

### Sync model (v1)

- Host keeps the canonical BPMN XML in memory.
- Clients send bpmn-js command descriptions; host re-applies them to its own headless bpmn-js instance (via jsdom) **or**, simpler, clients send full XML after each change and host diffs/overwrites. Start with full-XML broadcast; move to ops if latency or conflicts hurt.
- Presence (cheap, optional): each client listens to bpmn-js `selection.changed`, sends the selected element ids over the WebSocket; other clients call `canvas.addMarker(id, 'remote-<userId>')` / `removeMarker` and a few CSS rules colour the outline per user. No cursors, no persistence. ~30 lines; a connected-users list is the minimum.
- Upgrade path: swap the sync layer for **Yjs** (`y-websocket` on the host) when real concurrent editing is needed; there is no `y-bpmn-js` binding, so this means mapping bpmn-js commands to a `Y.Map` of elements.

### Tunnel (share)

- **Cloudflare quick tunnels** via `cloudflared`: no account, random public HTTPS URL, WebSocket support.
  - Fetch the platform binary on first use (cache in `~/.local-bpmn/`), or use an npm wrapper that does this.
  - Alternatives behind the same interface: `ngrok` (account, stable domains), `localtunnel`, `bore`.
- Security: public URL + unguessable session token in the path; host can revoke by restarting the share. Optional `--password`.
- Tailscale Funnel as a later option for teams already on Tailscale.

### Why tunnel over P2P

- Collaborators need zero install: a link is the whole onboarding.
- NAT traversal, TURN fallback and signaling are handled by the tunnel provider.
- Trade-offs: traffic transits Cloudflare; quick-tunnel uptime is best-effort; the host must stay online. Acceptable for sessions measured in hours.
- Hole-punching stacks (Hyperswarm/Pear) remain an option if a relay-free mode is ever required.

## Package layout

```
local-bpmn/
  bin/local-bpmn.js        # CLI entry
  src/server.js            # http + ws
  src/file.js              # read/write/watch
  src/tunnel.js            # cloudflared lifecycle
  web/index.html           # editor shell
  web/app.js               # bpmn-js + sync client
  web/vendor/bpmn-js/      # vendored build
```

## Open questions

- Full-XML vs operation-level sync for v1 — measure with 2–3 concurrent editors.
- How to handle a collaborator's change arriving while the host's file was just edited externally (IDE save).
- Whether to persist session tokens so a restart keeps the same link (requires a named tunnel / account).
