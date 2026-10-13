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
is written to disk, and every window (collaborators included) shows "Session ended". A second Ctrl-C stops
waiting for the editors but still finishes writing to disk (including the last check described under
[Saving and changes on disk](#saving-and-changes-on-disk)); a third one exits at once.

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
- A save on disk that races an edit in the browser (your IDE saves while an edit is still on its way to the
  file) is never overwritten: the change on disk is taken as the newer version and the browser edits not yet
  written are re-applied on top of it, element by element, as for two windows (see
  [Concurrent editing](#concurrent-editing)). The window whose edits were re-applied says "The file was
  changed on disk; your edits were applied on top of that change". If the same label or position was changed
  on both sides, the file's version is kept and that window says "Your change to “…” was not applied: it was
  changed on disk at the same time (the file's version was kept)" ("…it was deleted on disk" if the element
  is gone). This also holds when you press Ctrl-C right after the save: local-bpmn checks the file once more
  and lets the open windows re-apply their edits before the last write. A window that was disconnected
  meanwhile re-applies them when it reconnects. A program that saves slowly in place (the file is
  half-written for a while) and finishes after local-bpmn replaced the half-written file with your edit
  is handled the same way, also when it finishes writing through the file it had open. So is a program
  that deletes or moves the file away and then writes its copy, if that copy arrives within 2 s of
  local-bpmn recreating the file with your edit.
- A save from an older copy shortly after local-bpmn wrote your edits (an editor that read the file before
  they reached it and saves without reloading) replaces them on disk. local-bpmn compares the save with
  its recent writes element by element (by id; formatting does not count). Recent writes means each
  write less than 5 s after the one before, with no other program's change in between. The save lands
  within 5 s of the last of those writes. It counts as such a save if an element they changed is back
  as it was before them, or as it was after only some of them: the old name of an element you renamed,
  an element you deleted, or no trace of an element you created. Then the file keeps that save (it may be deliberate, e.g. a revert), your
  latest version is saved next to it (see below), and every window says "The file was saved on disk
  from an older copy, without the latest changes; they were saved next to it as <file name>". A
  window that was disconnected is told when it reconnects. Edits that were still waiting to be
  written are re-applied on top of that save as usual; the side file has them too. An element the
  other program changed in its own way (neither as before nor as yours) does not count. A revert of
  your last edits within those 5 s gives the same notice and side file.
- When an edit cannot be re-applied by anyone (its window has closed and has not reconnected within
  20 s, or local-bpmn is stopped before that, or the file changes again during shutdown), the file keeps
  the version on disk and the editor's version is saved next to it as
  `<name>.local-bpmn-unsaved-<yyyymmdd-hhmmss>.bpmn` (it shows up in `git status`); the terminal prints a
  warning with the file name. These files are never deleted automatically. The same happens at Ctrl-C less
  than 2 s after local-bpmn replaced a half-written file or recreated a deleted one, in case the program
  that was saving it finishes later from an older copy; the half-written file local-bpmn had replaced is
  then also kept, as `<name>.local-bpmn-replaced-<yyyymmdd-hhmmss>.bpmn`, so that a program still writing
  into it through the file it has open finishes its save there. If the file became half-written or disappeared
  less than 2 s before Ctrl-C (another program is rewriting it), local-bpmn does not write over it:
  edits still to be written are saved next to it instead. A save made right after local-bpmn's last
  write, or while the file is being rewritten like that, is checked once more before exiting. If it
  does not have every element local-bpmn's recent writes changed in the form they wrote (e.g. it comes
  from an older copy), or is still being written about 1 s later, your version is saved next to it too. This check runs 300 ms
  after the last write, so Ctrl-C takes up to 300 ms longer when it writes edits or comes right after
  a write, and up to about 1.3 s while another program is writing the file.
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
- Saves on disk racing a browser edit (see [Saving and changes on disk](#saving-and-changes-on-disk)) have
  some remaining gaps:
  - A save landing in the instant between local-bpmn's last check of the file and its rename (normally well
    under a millisecond) is overwritten without notice.
  - A save from a stale copy: a program reads the file, local-bpmn then writes your edit, and the program
    later writes back its older copy. An example is an IDE whose buffer was loaded before your edit
    reached the file and that saves without reloading. That save is the newer one on disk, so it replaces
    your edit. Within 5 s of local-bpmn's write this is noticed (see
    [Saving and changes on disk](#saving-and-changes-on-disk)); a stale save later than that, one that
    does not bring back anything the writes changed, one after a write that replaced a half-written or
    missing file (there is nothing to compare with), or one after local-bpmn has stopped (at Ctrl-C it
    looks once more 300 ms after its last write) is not: every window shows "Reloaded from disk" and
    nothing else tells you the edit is gone. How often this happens depends entirely on the timing
    between the other program's read and its write. It is the same as two editors saving the same file
    one after the other. The editor's undo cannot bring the edit back (its history is reset when a
    change on disk is shown). Redo the edit, or restore it from git or from the other program's undo or
    local history. Reloading the file in the other program before saving there avoids it.
  - The check for saves from an older copy compares elements by id and ignores indentation, line
    endings, attribute order and `<a></a>` versus `<a/>`. A program that rewrites attribute values or
    text in another form (e.g. other character escapes) can make a save that does contain your edit
    look different; at Ctrl-C (where an element changed again by the other program also counts) this
    gives a needless side file.
  - A program that leaves the file half-written, waits more than 2 s after local-bpmn replaced it with a
    browser edit, and only then finishes its save from an older copy replaces that edit; the editors only
    show "Reloaded from disk". If it finishes through the file it had open and pauses that long, its own
    change is lost instead. If local-bpmn is stopped while such a program is still writing, your edit is
    kept next to the file and the program's save ends up in the kept `….local-bpmn-replaced-….bpmn` file
    (if it writes through the file it had open) or in the file itself (if it writes by name).
  - A save that is valid for less than about 150 ms before the same program breaks the file again is not
    seen; the file has it again once that program saves again.
  - A change on disk is merged only for the edits concurrent editing re-applies (labels, moves, new
    elements and connections, deletes); other racing browser edits (resize, bendpoints, type changes, …) are
    dropped with a notice.
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
