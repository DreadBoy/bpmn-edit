# local-bpmn

Open a `.bpmn` file from your repo in a browser-based editor ([bpmn-js](https://bpmn.io)), have every change
written straight back to the file, and invite others to edit with you through a public link. No account, no
project setup; the file stays where it is, on your disk.

## Requirements

- Node.js 20.19 or later.
- Supported in v1: **macOS** with **Google Chrome**. Other systems and browsers may work but are not tested.

## Usage

```sh
npx local-bpmn path/to/file.bpmn
```

This starts a local server and opens the editor in your default browser. The terminal prints a line like

```
local-bpmn: editing path/to/file.bpmn at http://localhost:3000/?host=<secret>
```

Keep the terminal open while you edit. Press **Ctrl-C** to stop: open editors send their last edits, everything
is written to disk, and every window (collaborators included) shows "Session ended".

Options:

| Option | Default | |
|---|---|---|
| `-p, --port <n>` | `3000` | Preferred port. If it is busy, the next free one is used (the terminal says so). |
| `--no-open` | | Do not open the browser; open the printed URL yourself. |
| `-V, --version` | | Print the version. |
| `-h, --help` | | Show help. |

The file must exist and be a regular file, and its first element (after the XML declaration, comments and a
DOCTYPE) must be `definitions` in the BPMN 2.0 model namespace. Otherwise local-bpmn prints an error and exits
with status 1. That is the only check at startup: the rest of the file is not validated then, so a truncated
or otherwise broken file can still be opened, and the editor then shows an error if it cannot render it.
local-bpmn does not create new files.

## Saving and changes on disk

- Every edit is saved automatically: the browser sends the diagram about 300 ms after your last change and
  local-bpmn writes it to the file 250 ms later. The write is atomic (temporary file, then rename) and keeps
  the file's permissions. `git diff` shows the result right away; the toolbar shows the save status.
- local-bpmn watches the file. When another program changes it (your IDE, `git checkout`, …), every open
  editor reloads the diagram from disk, keeping the viewport and selection.
- If the file on disk becomes invalid (e.g. half-written or not BPMN), the editor keeps showing the last good
  version and says so; nothing is written until you edit again. If the file is deleted, your next edit
  recreates it.
- Several windows (yours or collaborators') can edit at the same time; see [Concurrent editing](#concurrent-editing).

## Sharing

1. Click **Share** in the toolbar of the window local-bpmn opened for you.
2. local-bpmn starts a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   and shows a link like `https://<random-name>.trycloudflare.com/s/<token>`. This usually takes 5–15 s (longer on the first Share, while `cloudflared` is downloaded).
3. Click **Copy** and send the link. Whoever opens it gets the editor with your current diagram; their edits
   sync live to you, to the other collaborators and to your file. The toolbar lists everyone connected, and
   the elements each of them has selected are outlined in their colour.
4. **Stop sharing** ends it: collaborators are disconnected and the link stops working.

Things to know:

- Sharing needs `cloudflared`. If it is on your `PATH`, that one is used. Otherwise, on the first Share,
  local-bpmn downloads the latest release for your platform from
  [github.com/cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) into
  `~/.local-bpmn/bin/` and reuses it from then on. Set `LOCAL_BPMN_HOME` to use another directory instead of
  `~/.local-bpmn`.
- **Every Share gives a new link, and so does every restart of local-bpmn.** A quick tunnel gets a new random
  hostname each time; the old link stops working at once (Cloudflare shows error 1033). Send collaborators the
  new link. Links that survive a restart are not supported in v1 (they would need a named Cloudflare tunnel,
  i.e. your own Cloudflare account and domain).
- Cloudflare rate-limits how many quick tunnels can be created from one network. If it refuses (HTTP 429),
  local-bpmn says so and does not retry by itself; wait a few minutes and click Share again. Quick tunnels are
  meant for testing and development and come without an uptime guarantee.
- Only the window opened from the URL printed in the terminal (and its reloads) can share. Another tab at
  `http://localhost:<port>/` can edit but has no Share button; open the printed URL again for that.
- If a connection drops (network change, sleep, tunnel hiccup), the editor shows "Reconnecting…", reconnects
  with backoff and re-sends edits that were not saved yet. It gives up after about a minute and offers
  **Try again**.

## Security notes

- The server listens on loopback only (`127.0.0.1` and `::1`). Requests must name `localhost`, `127.0.0.1`
  or `[::1]` with the server's port, or the active tunnel's hostname, in their `Host` header; this protects
  against DNS rebinding and other web sites.
- **Host secret.** The printed URL contains `?host=<secret>`, created anew at every start. Whoever opens that
  URL can start and stop sharing. The page moves the secret out of the address bar right away, so it is not
  bookmarked or copied with the URL. Treat the terminal output as private.
- **Session token.** The share link contains a random token (192 bit), created when sharing starts. **Anyone
  with the link can view and edit the diagram** until you click Stop sharing or stop local-bpmn; there are no
  accounts or passwords. A wrong token, or any other path through the tunnel, gets 404.
- Collaborators can view and edit this one diagram, and see the file name (not its path on your machine)
  and the names other users chose. They cannot start or stop sharing or reach any other file or endpoint; nothing sent to them
  contains the host secret, and through the tunnel even the secret grants no host powers.
- The `cloudflared` binary that local-bpmn downloads comes from the latest GitHub release over HTTPS. Its
  checksum and signature are not checked. If you would rather not rely on that, install `cloudflared`
  yourself and put it on your `PATH`, which is checked first.
- All traffic between collaborators and your machine goes through Cloudflare's network (HTTPS to Cloudflare,
  then the tunnel to `cloudflared` on your machine). Do not share diagrams you would not send through a
  third party.
- To stop sharing: click **Stop sharing**, or stop local-bpmn with Ctrl-C. Either way the token becomes
  invalid immediately and the tunnel is shut down. Stopping and sharing again gives a new link and token.

## Known limitations

- **Formatting churn on the first save.** The first save rewrites the file in bpmn-js's own formatting
  (attribute order, indentation, the `<definitions>` header on one line), so the first `git diff` can show
  many lines unrelated to your edit; later saves only change what you edited. XML comments, processing
  instructions and a DOCTYPE are not kept. Commit the file before the first edit if you want a clean diff.
- Concurrent editing (below) is not a CRDT; some edits can be refused with a notice instead of merged.
- Undo history is reset whenever another window's change or a change on disk is shown.
- A change made on disk at about the same time as an edit in the browser: one of the two wins and the other
  is lost.
  - If the browser's edit was based on the version from before the disk change, the edit overwrites the
    change made on disk. The terminal prints "an edit from the browser replaced a change made on disk". If
    the change on disk arrived while you were still dragging or editing a label, the toolbar shows "Disk
    changed; reloads after your edit" (its tooltip says your edit replaces the change on disk if it is saved
    first) and the browser console logs a warning.
  - If the disk change arrives while the accepted edit is still waiting to be written (250 ms), the disk
    version wins and the edit is lost. The editors show "Reloaded from disk"; only the terminal says that an
    edit was dropped ("a pending save from the editor was discarded").
- Only one file per session.

### Concurrent editing

local-bpmn keeps the canonical diagram on your machine and gives it a version number. A window sends its
whole diagram after an edit, based on the version it last saw. local-bpmn accepts it only if no one else's edit
was accepted in between; otherwise that window shows the newer diagram, re-applies its own edits element by
element and sends again. In practice:

- Edits to different elements made at the same time are all kept (with the exception of the commands
  listed further down).
- The same label or position changed by two people: the first one saved wins; the other person sees a notice
  "…was not applied: someone else changed it first".
- Delete versus an edit of the same element: the delete wins, with a notice to the other person.
- Some commands (resize, bendpoints, changing an element's type, colours, lanes/participants, undo/redo of
  already saved edits) are not re-applied: if they race someone else's edit they are dropped, with a notice.
- An incoming change is held back while you drag, edit a label or have a popup menu open, and shown after.

## License

local-bpmn is MIT licensed, see [LICENSE](LICENSE).

It ships a prebuilt [bpmn-js](https://github.com/bpmn-io/bpmn-js) (in `web/vendor/bpmn-js/`, with its
[license](web/vendor/bpmn-js/LICENSE)). The bpmn-js license requires that the bpmn.io watermark shown in the
diagram (the logo linking to https://bpmn.io) is not removed or changed and stays fully visible; keep it that
way in any fork or modification.
