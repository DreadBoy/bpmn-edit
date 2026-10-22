# How bpmn-edit works

This is the detailed reference behind the [README](../README.md): exact timings, what happens in edge cases,
how sharing is secured, and the known gaps. You don't need any of it to use bpmn-edit.

- [Starting and stopping](#starting-and-stopping)
- [Creating a new file](#creating-a-new-file)
- [Saving and changes on disk](#saving-and-changes-on-disk)
- [Colours](#colours)
- [Sharing](#sharing)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [Concurrent editing](#concurrent-editing)

## Starting and stopping

```sh
npx bpmn-edit path/to/file.bpmn
```

This starts a local server and opens the editor in your default browser. The terminal prints a line like

```
bpmn-edit: editing path/to/file.bpmn at http://localhost:3000/?host=<secret>
```

Options:

| Option | Default | |
|---|---|---|
| `-p, --port <n>` | `3000` | Preferred port. If it is busy, the next free one is used (the terminal says so). |
| `--create` | | Create the file if it does not exist, without asking (see [Creating a new file](#creating-a-new-file)). |
| `--no-open` | | Do not open the browser; open the printed URL yourself. |
| `-V, --version` | | Print the version. |
| `-h, --help` | | Show help. |

An existing file must be a regular file, and its first element (after the XML declaration, comments and a
DOCTYPE) must be `definitions` in the BPMN 2.0 model namespace. Otherwise bpmn-edit prints an error and exits
with status 1. That is the only check at startup: the rest of the file is not validated then, so a truncated
or otherwise broken file can still be opened, and the editor then shows an error if it cannot render it.

Keep the terminal open while you edit. Press **Ctrl-C** to stop: open editors send their last edits, everything
is written to disk, and every window (collaborators included) shows "Session ended". A second Ctrl-C stops
waiting for the editors but still finishes writing to disk (including the last check described under
[Saving and changes on disk](#saving-and-changes-on-disk)); a third one exits at once.

## Creating a new file

When the path does not exist:

- **Interactive terminal** (stdin, stdout and stderr, where the question goes, are all TTYs): bpmn-edit asks
  `new.bpmn does not exist. Create it? [y/N]` (with the path as you typed it). On `y` or `yes` (any letter
  case) it writes a blank diagram (one start event, like the bpmn.io demo), prints `bpmn-edit: created new.bpmn`
  and opens it. Any other answer, an empty one, Ctrl-C or Ctrl-D prints `bpmn-edit: error: new.bpmn was not
  created` and exits with status 1.
- **Not interactive** (scripts, CI, piped input or output): it does not wait for an answer. It prints
  `bpmn-edit: error: File not found: new.bpmn (pass --create to create it)` and exits with status 1.
- **`--create`**: creates the file without asking. If the file already exists, it is opened unchanged.

In every case bpmn-edit refuses (exit status 1) when the file name does not end in `.bpmn` (any letter case,
e.g. `Order.BPMN`; `cannot create x.txt: the name must end in .bpmn`) or the parent folder does not exist
(`cannot create a/b.bpmn: folder a does not exist (bpmn-edit does not create folders)`); it never creates
folders. The new file is created atomically and never overwrites anything (it is opened with the
exclusive-create flag `wx`, so a file that appears in the meantime is opened as it is).

## Saving and changes on disk

- Every edit is saved automatically: the browser sends the diagram about 300 ms after your last change and
  bpmn-edit writes it to the file 250 ms later. The write is atomic (temporary file, then rename) and keeps
  the file's permissions. `git diff` shows the result right away; the toolbar shows the save status.
- A save changes only what you edited. The rest of the file keeps its exact text: XML comments, processing
  instructions, the DOCTYPE and references to its entities, CDATA sections, attributes and elements the
  editor does not know, attribute order and quotes, how numbers are written, indentation, line endings and
  the final newline. New elements are written in the file's own style (indentation, quotes, one attribute
  per line if the file does that, its namespace prefixes). So the first `git diff` after renaming a task
  shows that one line. An element you move into a sub-process keeps its own text (comments and all); one
  whose type you change keeps its content and gets the new tag name, also extensions the editor itself would
  drop. What counts as the edit is up to bpmn-js: moving a shape also moves the waypoints of its connections
  and can re-measure nearby labels, and deleting a connection removes it from the elements it connected.
- bpmn-edit watches the file. When another program changes it (your IDE, `git checkout`, …), every open
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
  is gone). This also holds when you press Ctrl-C right after the save: bpmn-edit checks the file once more
  and lets the open windows re-apply their edits before the last write. A window that was disconnected
  meanwhile re-applies them when it reconnects. A program that saves slowly in place (the file is
  half-written for a while) and finishes after bpmn-edit replaced the half-written file with your edit
  is handled the same way, also when it finishes writing through the file it had open. So is a program
  that deletes or moves the file away and then writes its copy, if that copy arrives within 2 s of
  bpmn-edit recreating the file with your edit.
- A save from an older copy shortly after bpmn-edit wrote your edits (an editor that read the file before
  they reached it and saves without reloading) replaces them on disk. bpmn-edit compares the save with
  its recent writes element by element (by id; formatting does not count). Recent writes means each
  write less than 5 s after the one before, with no other program's change in between. The save lands
  within 5 s of the last of those writes. It counts as such a save if an element they changed is back
  as it was before them, or as it was after only some of them: the old name of an element you renamed,
  an element you deleted, or no trace of an element you created. This also holds when the other program
  changed that element too: a task you renamed that comes back with its old name and documentation the
  other program added counts as such a save. Then the file keeps that save (it may be deliberate, e.g. a
  revert), your latest version is saved next to it (see below), and every window says "The file was saved
  on disk from an older copy, without the latest changes; they were saved next to it as <file name>". A
  window that was disconnected is told when it reconnects. Edits that were still waiting to be
  written are re-applied on top of that save as usual; the side file has them too. An element the
  other program changed in its own way counts only if something you changed in it is back as it was
  (not if, e.g., it renamed the task you renamed to yet another name). A revert of
  your last edits within those 5 s gives the same notice and side file.
- When an edit cannot be re-applied by anyone (its window has closed and has not reconnected within
  20 s, or bpmn-edit is stopped before that, or the file changes again during shutdown), the file keeps
  the version on disk and the editor's version is saved next to it as
  `<name>.bpmn-edit-unsaved-<yyyymmdd-hhmmss>.bpmn` (it shows up in `git status`); the terminal prints a
  warning with the file name. These files are never deleted automatically. The same happens at Ctrl-C less
  than 2 s after bpmn-edit replaced a half-written file or recreated a deleted one, in case the program
  that was saving it finishes later from an older copy; the half-written file bpmn-edit had replaced is
  then also kept, as `<name>.bpmn-edit-replaced-<yyyymmdd-hhmmss>.bpmn`, so that a program still writing
  into it through the file it has open finishes its save there. If the file became half-written or
  disappeared less than 2 s before Ctrl-C (another program is rewriting it), bpmn-edit does not write over
  it: edits still to be written are saved next to it instead. A save made right after bpmn-edit's last
  write, or while the file is being rewritten like that, is checked once more before exiting. If it
  does not have every element bpmn-edit's recent writes changed in the form they wrote (e.g. it comes
  from an older copy), or is still being written about 1 s later, your version is saved next to it too.
  This check runs 300 ms after the last write, so Ctrl-C takes up to 300 ms longer when it writes edits or
  comes right after a write, and up to about 1.3 s while another program is writing the file.
- Several windows (yours or collaborators') can edit at the same time; see [Concurrent editing](#concurrent-editing).

## Colours

- The colour picker is [bpmn-js-color-picker](https://github.com/bpmn-io/bpmn-js-color-picker) (bpmn.io's
  plugin, MIT), bundled into `web/vendor/bpmn-js-color-picker/` by `npm run vendor` and loaded as a module
  of the editor's one bpmn-js. Select elements (any number, connections included), click **Set color** in
  the context pad and pick Blue, Orange, Green, Red, Purple or **Default** (no colour). Undo and redo work as
  for any other edit; collaborators see the colours live.
- A colour is saved on the element's DI shape or edge in both common formats: bpmn.io's
  `bioc:fill` / `bioc:stroke` and the OMG's BPMN in Color `color:background-color` / `color:border-color`
  (connections get the stroke colour only; a colour on an external label is `color:color` on its
  `BPMNLabel`). Files coloured by Camunda Modeler or bpmn.io (either format or both, with any namespace
  prefixes) show their colours, and keep them byte for byte through unrelated edits.
- The first colour in a file declares the namespaces it needs (`xmlns:bioc`, `xmlns:color`) once, on the
  root element, in the file's own attribute layout; a file that already declares them (under any prefix)
  is written with its own prefixes. **Default** removes the attributes, and when the last colour goes, the
  colour namespace declarations go too (bpmn-js drops them then), so colouring an uncoloured file and
  resetting it leaves no `git diff` (apart from a label bpmn-js may have re-measured; see below). An undo
  after that declares them again at the end of the root's attributes. A declaration a file has without using it stays through other edits.
- Changing a colour can make bpmn-js re-measure the element's external label (one `dc:Bounds` line), as it
  does for other edits of the element.
- A colour change racing another window's edit is not re-applied (see [Concurrent editing](#concurrent-editing)).

## Sharing

1. Click **Share** in the toolbar of the window bpmn-edit opened for you.
2. bpmn-edit starts a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
   and shows a link like `https://<random-name>.trycloudflare.com/s/<token>`. This usually takes 5–15 s
   (longer on the first Share, while `cloudflared` is downloaded).
3. Click **Copy** and send the link. Whoever opens it gets the editor with your current diagram; their edits
   sync live to you, to the other collaborators and to your file. The toolbar lists everyone connected, and
   the elements each of them has selected are outlined in their colour.
4. **Stop sharing** ends it: collaborators are disconnected and the link stops working.

Things to know:

- Sharing needs `cloudflared`. If it is on your `PATH`, that one is used. Otherwise, on the first Share,
  bpmn-edit downloads the latest release for your platform from
  [github.com/cloudflare/cloudflared](https://github.com/cloudflare/cloudflared/releases) into
  `~/.bpmn-edit/bin/` and reuses it from then on. Set `BPMN_EDIT_HOME` to use another directory instead of
  `~/.bpmn-edit`.
- **Every Share gives a new link, and so does every restart of bpmn-edit.** A quick tunnel gets a new random
  hostname each time; the old link stops working at once (Cloudflare shows error 1033). Send collaborators the
  new link. Links that survive a restart are not supported in v1 (they would need a named Cloudflare tunnel,
  i.e. your own Cloudflare account and domain).
- Cloudflare rate-limits how many quick tunnels can be created from one network. If it refuses (HTTP 429),
  bpmn-edit says so and does not retry by itself; wait a few minutes and click Share again. Quick tunnels are
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
  with the link can view and edit the diagram** until you click Stop sharing or stop bpmn-edit; there are no
  accounts or passwords. A wrong token, or any other path through the tunnel, gets 404.
- Collaborators can view and edit this one diagram, and see the file name (not its path on your machine)
  and the names other users chose. They cannot start or stop sharing or reach any other file or endpoint;
  nothing sent to them contains the host secret, and through the tunnel even the secret grants no host powers.
- The `cloudflared` binary that bpmn-edit downloads comes from the latest GitHub release over HTTPS. Its
  checksum and signature are not checked. If you would rather not rely on that, install `cloudflared`
  yourself and put it on your `PATH`, which is checked first.
- All traffic between collaborators and your machine goes through Cloudflare's network (HTTPS to Cloudflare,
  then the tunnel to `cloudflared` on your machine). Do not share diagrams you would not send through a
  third party.
- To stop sharing: click **Stop sharing**, or stop bpmn-edit with Ctrl-C. Either way the token becomes
  invalid immediately and the tunnel is shut down. Stopping and sharing again gives a new link and token.

## Known limitations

- **Formatting in rare cases.** Every save is checked before it is written: read back, the file must have
  exactly your edit and nothing else changed. When bpmn-edit cannot write a save that way (e.g. a changed
  text next to an XML comment inside the same element, or a new element in a part of an older file that
  bpmn-js reorganises when it opens it, such as a collapsed sub-process of a file from bpmn-js before
  version 9), it writes that save in bpmn-js's order of elements and attributes (and its spelling of numbers,
  default attributes and character references, e.g. `&#38;` becomes `&amp;`), still with the file's
  indentation, quotes, line endings, header, texts (CDATA, entity references) and comments and processing
  instructions next to the elements they were next to. `git diff` then shows more than your edit, and the
  terminal says so. Whatever such a save cannot keep (a comment whose element is gone, or one inside a text
  that changed) is named on the terminal, every time. If the file cannot be read as XML at all, the save is
  bpmn-js's output as it is, and the terminal lists the comments, processing instructions and DOCTYPE it
  drops. Comments inside an element you delete go with it; undoing the delete in the same run of bpmn-edit
  brings them back with the element (if bpmn-js brings the element back changed, e.g. with its flow
  references in another order, its old text is used with that change patched in). Cut and paste does not
  carry an element's comments or extensions over (backlog). After an undo, a few values can come back the
  way bpmn-js writes them (a re-ordered flow reference, a respelled number in a label or waypoint).
- Concurrent editing (below) is not a CRDT; some edits can be refused with a notice instead of merged.
- Undo history is reset whenever another window's change or a change on disk is shown.
- Saves on disk racing a browser edit (see [Saving and changes on disk](#saving-and-changes-on-disk)) have
  some remaining gaps:
  - A save landing in the instant between bpmn-edit's last check of the file and its rename (normally well
    under a millisecond) is overwritten without notice.
  - A save from a stale copy: a program reads the file, bpmn-edit then writes your edit, and the program
    later writes back its older copy. An example is an IDE whose buffer was loaded before your edit
    reached the file and that saves without reloading. That save is the newer one on disk, so it replaces
    your edit. Within 5 s of bpmn-edit's write this is noticed (see
    [Saving and changes on disk](#saving-and-changes-on-disk)); a stale save later than that, one that
    does not bring back anything the writes changed, one after a write that replaced a half-written or
    missing file (there is nothing to compare with), or one after bpmn-edit has stopped (at Ctrl-C it
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
  - A program that leaves the file half-written, waits more than 2 s after bpmn-edit replaced it with a
    browser edit, and only then finishes its save from an older copy replaces that edit; the editors only
    show "Reloaded from disk". If it finishes through the file it had open and pauses that long, its own
    change is lost instead. If bpmn-edit is stopped while such a program is still writing, your edit is
    kept next to the file and the program's save ends up in the kept `….bpmn-edit-replaced-….bpmn` file
    (if it writes through the file it had open) or in the file itself (if it writes by name).
  - A save that is valid for less than about 150 ms before the same program breaks the file again is not
    seen; the file has it again once that program saves again.
  - A change on disk is merged only for the edits concurrent editing re-applies (labels, moves, new
    elements and connections, deletes); other racing browser edits (resize, bendpoints, type changes, …) are
    dropped with a notice.
- Only one file per session.

## Concurrent editing

bpmn-edit keeps the canonical diagram on your machine and gives it a version number. A window sends its
whole diagram after an edit, based on the version it last saw. bpmn-edit accepts it only if no one else's edit
was accepted in between; otherwise that window shows the newer diagram, re-applies its own edits element by
element and sends again. In practice:

- Edits to different elements made at the same time are all kept (with the exception of the commands
  listed further down).
- The same label or position changed by two people: the first one saved wins; the other person sees a notice
  "…was not applied: someone else changed it first".
- Delete versus an edit of the same element: the delete wins, with a notice to the other person.
- Some commands (resize, bendpoints, changing an element's type, colours, lanes/participants, undo/redo of
  already saved edits) are not re-applied: if they race someone else's edit they are dropped, with a notice.
- Properties panel: changes of plain values (a name, a signal's or message's name, an error code, a flag)
  are re-applied like labels; the same value changed by two people gives the "someone else changed it
  first" notice. Other panel changes (creating or picking a signal, message, error or escalation, changing
  an ID, documentation) are not re-applied: racing someone else's edit, they are dropped with the notice
  "Your edit (properties panel change) could not be merged…".
- Text you are typing in a panel field is not committed until you pause (about half a second) or leave the
  field. Someone else's change arriving meanwhile does not wait for you: it is shown, and your text (every
  key), the focus and the cursor stay in the field (the panel keeps showing the element you selected) and
  are then committed on top of it. If that change deleted the element, or changed the very value you are
  typing (also from disk), your text is dropped and you get the usual notice.
- An incoming change is held back while you drag, edit a label or have a popup menu open, and shown after.
