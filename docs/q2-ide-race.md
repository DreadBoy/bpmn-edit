# Q2: browser edit racing a save made on disk (IDE)

Measurements for `PLAN.md` Q2, taken on the code as it was after Q1 (commit `0fd8d5a`), before any
change for Q2. Decision and the change are in `docs/decisions.md` (section Q2); the numbers after the
change are at the end of this file.

## Method

`test/e2e/q2-ide-race.measure.spec.js` (not part of the regular suite; run with
`BPMN_EDIT_MEASURE=1 BPMN_EDIT_MEASURE_OUT=<dir> npx playwright test q2-ide-race.measure`).

- Real CLI (`node bin/bpmn-edit.js`, default write debounce 250 ms, settle delay 150 ms), Google Chrome
  via Playwright (`channel: 'chrome'`), macOS. The file is `test/fixtures/order.bpmn` in a fresh git
  repo with `core.autocrlf=false` set explicitly.
- Two browser windows (separate contexts). Window A makes the browser edit: double-click
  "Ship order", type a new name, click the canvas (real mouse and keyboard). Window B only watches.
- The "IDE save" reads the file and writes it back in place (`fs.writeFile`) with "Check stock"
  renamed, i.e. an editor whose buffer is in sync with the file saves a different change.
- Every trial uses new names, so afterwards the test reads the two names from the file on disk and
  from both windows (bpmn-js model). A trial is counted once both windows say "Saved" and nothing
  happened for 1.2 s. Toasts (`#toast`) shown in either window and host stderr warnings are recorded.
- A change is **lost** if its name is not in the file afterwards. A loss is **silent** if no window
  showed a toast and no copy was kept anywhere (stderr warnings do not count: nobody reads the
  host's terminal while editing in the browser, and the warning does not say what was lost).

Scenarios (offsets drawn uniformly at random per trial):

| | What races | Trials |
|---|---|---|
| a | browser edit committed, IDE save 0–600 ms later (client send debounce 300 ms + host write debounce 250 ms: the whole span in which the edit is not on disk yet) | 15 |
| b | IDE save, browser edit committed 0–400 ms later | 15 |
| c | IDE save lands 20–140 ms before the host writes the accepted browser edit (host write = time A receives the ack + 250 ms) | 15 |
| d | browser edit accepted (ack received, host write pending), IDE save, SIGINT to the CLI's node process 0–100 ms later | 10 (fresh CLI each) |

## Results before the change

| | Both changes on disk | Browser edit lost | Disk change lost | Lost silently | Toast shown | Windows ≠ disk afterwards |
|---|---|---|---|---|---|---|
| a | 2/15 | 7/15 | 6/15 | **13/15** | 0 | 0 |
| b | 11/15 | 0/15 | 4/15 | **4/15** | 0 | 0 |
| c | 0/15 | 0/15 | 15/15 | **15/15** | 0 | 0 |
| d | 0/10 | 0/10 | 10/10 | **10/10** | 0 | – (windows disconnected) |

Per-trial detail, scenario a (offset ms → outcome; U = browser edit on disk, D = disk change on disk,
w = stderr warning): `14 U-w`, `29 U-w`, `115 U-w`, `176 -Dw`, `192 -Dw`, `198 -Dw`, `268 -Dw`,
`282 -Dw`, `291 -Dw`, `396 -Dw`, `406 U-`, `449 U-`, `510 U-`, `562 UD`, `585 UD`. Scenario b: the 4
losses are the offsets 21, 28, 33 and 115 ms (`U-w`); from 148 ms on both changes survived.

So with an IDE save inside the ~600 ms after a browser edit (or ~120 ms before one), one of the two
changes is lost in 32 of 45 trials, and **none** of the 42 losses (incl. d) was shown in a browser
window. The windows always agreed with the file afterwards: everyone converged on the same, smaller
document, which is what makes the loss hard to notice. The browser only ever showed the transient
"Reloaded from disk" notice.

## Root causes in the code

1. **Disk wins over an accepted, unwritten browser edit** (a, 176–396 ms): `src/file.js` `checkDisk()`
   calls `dropPendingWrite()` when an external change settles while a write is waiting in the
   250 ms debounce. `Session.replaceFromDisk()` then pushes the disk version to every window. The
   browser edit was already acknowledged (its window forgot it), so nothing can bring it back; only
   stderr says "a pending save from the editor was discarded".
2. **The host writes over an external save it has not noticed yet** (a 406–510 ms, all of c, d): the
   watcher waits until the file has been quiet for 150 ms (`settleMs`) before reading it, but the
   write loop (`kick()` / `writeOne()`) never looks at the disk. A save in those 150 ms is renamed
   over. The settle check afterwards reads our own content, takes it as known and reports nothing:
   not even a stderr warning.
3. **Browser document replaces a disk change** (a 14–115 ms, b 21–115 ms): `Session.applyUpdate()`
   accepts an update based on a version that only a disk change replaced ("last write wins", stderr
   warning), and `web/app.js` `settleNow()` deliberately sends unsent edits over a disk change instead
   of re-applying them on it. The whole browser document, built on the old file, replaces the IDE
   save.
4. **Shutdown** (d): `bin/bpmn-edit.js` `shutdown()` calls `store.unwatch()`, which cancels the
   pending settle check, then `store.flush()` writes the pending edit: same as 2.

## Results after the change

See `docs/decisions.md`, Q2, for the policy. Same spec, same trial counts, final code:

| | Both changes on disk | Browser edit lost | Disk change lost | Lost silently | "Merged" toast in A | Windows ≠ disk afterwards |
|---|---|---|---|---|---|---|
| a | 15/15 | 0 | 0 | 0 | 15/15 | 0 |
| b | 15/15 | 0 | 0 | 0 | 3/15 | 0 |
| c | 15/15 | 0 | 0 | 0 | 15/15 | 0 |
| d | 10/10 | 0 | 0 | 0 | 10/10 | – |

- b: in 12 of 15 trials the change on disk was already showing before the user double-clicked, so
  the edit was made on the new version and there was nothing to merge (no toast needed). In the 3
  others (offsets 54, 68, 116 ms) the edit was re-applied on top and the window said so.
- d: the shutdown now checks the file before the final write; the change was found in all 10 trials,
  the window re-applied its edit and both changes were written before exit (exit code 0).
- Nothing was overwritten or kept aside in any trial. (Since round 2 the stderr line about edits
  being re-applied starts with `warning:`; in the round-3 re-run it appeared in a 9/15, c 15/15 and
  d 10/10, i.e. whenever accepted edits were re-applied.)

An intermediate run (before shutdown re-checked the file) had a-c identical and d at 0/10 merged,
10/10 "disk change kept, browser version saved next to it" (`order.bpmn-edit-unsaved-<time>.bpmn`):
that is now the fallback when no window is left to re-apply the edit (covered by
`test/e2e/q2-ide-race.spec.js`).

## Round 2: file invalid or deleted just before the save

An independent check found a case the scenarios above did not cover: the file was made invalid (half
written) or deleted, the host reported it, then a browser edit was accepted and a valid save landed
10–130 ms before the host's write. The store forgets what is on disk while the file is invalid or
missing (`diskXml = null`), and the pre-write check skipped such a file, so the write replaced the
valid save: 10/10 lost for "invalid", 10/10 for "deleted" (in-place, temp+rename and truncate+write
saves; `core.autocrlf` false and input), silently apart from "valid again" on stderr.

Fix: in that state the pre-write check reads the file and treats complete BPMN as a change made on
disk (held write, rebase as above); a file that is still invalid or missing is still replaced, as
documented. Same repro afterwards: 10/10 both kept for "invalid", 10/10 for "deleted", merged toast in
the editing window. Both cases are in `test/e2e/q2-ide-race.spec.js`.

Also changed in that round: unsaved edits of a window that has closed are kept next to the file when
a change on disk replaces them during the session (before: stderr only), and every Q2 stderr line
starts with `warning:`.

## Round 3: slow save finishing after the host replaced the half-written file

The round-2 check found one more silent loss. An IDE writes half the file (invalid) and it stays
like that for longer than the settle delay. A browser edit is made and the host writes it over the
broken file (allowed). The IDE then finishes its save from its own copy, which lacks the edit. The
edit disappeared from disk and from every window, which showed only "Reloaded from disk".

Fix (`src/file.js`):

- A write over a missing or invalid file stays unconfirmed for 2 s (`confirmMs`; another
  missing/invalid observation restarts the wait). A valid save arriving meanwhile is treated as
  replacing it: the edits are re-applied on top in their windows (merged toast), or kept aside if
  their window has closed.
- An invalid file is replaced only while it holds exactly the broken content reported after it
  settled. A file that changed again (e.g. truncated by an in-place save about to rewrite it) holds
  the write back until it settles. Without this, the first re-run lost an IDE save once: the host's
  rename landed between the IDE's truncate and its write, so the IDE wrote into the replaced file.

Verifier scripts (10 trials each; `run2.mjs invSlow`, `run3.mjs flips` with `FLIPMODE`):

| Run | Before (round 2 code) | After |
|---|---|---|
| invSlow (400–900 ms pause) | 2/10 ok | 10/10 ok |
| flips, slow (150–350 ms pauses) | 2/10 ok | 9/10 ok, 0 losses |
| flips, fresh (IDE re-reads before finishing) | 6/10 ok | 10/10 ok |
| flips, fast (3–20 ms pauses) | 10/10 ok | 10/10 ok |

The one remaining "slow" flag is not a loss. The IDE made the file valid for about 60 ms, less than
the settle delay, then broke it again, so the host never saw that version. The host's write over
the broken file lacked it until the IDE's next save; the final file had every change. This is
listed as a known limit in `docs/decisions.md`.

The measurement spec above, re-run after this round: a–d 15/15, 15/15, 15/15 and 10/10 with both
changes on disk, no silent loss, nothing kept aside. New E2E case in
`test/e2e/q2-ide-race.spec.js`: half-written file, browser edit written over it, then the IDE
finishes its save; both changes are kept and window A shows the merged toast.

## Round 4: the unconfirmed window

The round-3 check (verifier script `run4.mjs`) found two defects in the 2 s "unconfirmed" window.

- **D1, Ctrl-C while the IDE has broken the file again.** The IDE writes half its copy; the host
  writes a browser edit over it (unconfirmed); 200–1000 ms later the IDE writes a partial file
  again; SIGINT. Before: exit 0 at once, no stderr, no side file, the edit nowhere (17/17).
  Shutdown ignored the unconfirmed write because nothing was pending. Fix: flush() keeps an
  unconfirmed write aside when the file no longer holds it. Also, during the session an unconfirmed
  write is now only confirmed once the file holds it at the end of the wait (before, the timer
  confirmed it regardless and a later save of the IDE's copy replaced the edit silently). The wait
  now restarts with each write.
- **D2, false conflict toast.** File broken; window A drags "Ship order" 70 px, which the host writes
  over it; an IDE that reloaded the file (so its copy has the move) saves a rename 350–1400 ms
  later. Before: A showed "Your change to “Ship order” was not applied: it was changed on disk…"
  though the move was on disk and in both windows (10/10). Fix: re-applying a move whose shapes are
  already at the target counts as applied (labels, create, connect and delete were already
  idempotent).
- Also, right before the rename the host now re-stats the file synchronously and checks again if
  it changed during the check, narrowing the remaining check-to-rename gap (see Known limits in
  `docs/decisions.md`).

| Verifier run (`run4.mjs`) | Before | After |
|---|---|---|
| ctrlCInv (partial again, SIGINT 0–60 ms later) | 0/10 ok | 10/10 ok (file left as the IDE's partial, edit in side file) |
| ctrlCInv late (SIGINT 200–600 ms later) | 0/4 ok | 6/6 ok |
| ctrlCInv noFinish (IDE never finishes) | 0/3 ok | 6/6 edit kept aside; the script flags 1 because it expects the IDE's change on disk, which the IDE never wrote |
| freshMove (D2) | 0/10 ok | 10/10 ok, no toast |
| slow 1500 / multi / close / ctrlC / ctrlCNoIde / closeNoIde / delRec / freshLabel | ok | 6/6 each |
| slow 2500 (IDE finishes 2.5 s after the host's write, file untouched meanwhile) | silent 6/6 | silent 4/4: known limit, unchanged |

Older scripts re-run: `run2.mjs invSlow` 6/6 ok; `run3.mjs flips` slow 7/10, all 3 flags being the
short-lived-save transient (known limit, final file complete), no losses.

New E2E cases: Ctrl-C after the slow save broke the file again (file left alone, edit kept aside,
stderr names it), and a save that already contains a move made over a broken file (no conflict or
dropped toast, move and rename both on disk).

## Round 5: Ctrl-C inside the unconfirmed window, IDE finishing after exit

The round-4 check (verifier script `c2r4/run5.mjs`) found one more silent loss. The IDE leaves the
file half-written; window A's edit is written over it (unconfirmed); Ctrl-C 0.1–1.2 s later; after
the host has exited, the IDE finishes its save from its own copy. Exit 0, no stderr, no side file,
A's edit gone (8/8). Variant with a second accepted edit still waiting for its write at Ctrl-C: the
shutdown wrote it over the unconfirmed write, saw the file hold it, kept nothing, and both edits were
lost (8/8).

Fix: at shutdown an unconfirmed write is always kept aside (side file + stderr "…was replaced by the
editor less than 2 s ago while it was broken or missing … also saved to …"), whether or not the file
holds it. Waiting out the rest of the 2 s at shutdown was considered and rejected: it delays Ctrl-C
and still loses the edit when the IDE finishes after the wait, which is exactly this scenario. Also:
the confirm wait no longer restarts with each write (with continuous editing it never ended, and
every Ctrl-C then kept a spurious copy: the verifier's `brokenEditsCtrlC` flagged 4/4 until this was
changed), the file is read again when the wait ends, and the "merged" toast is only shown when
something was actually re-applied.

| Verifier run | Before | After |
|---|---|---|
| `run5.mjs ctrlCAfterExit` | 0/8 ok | 8/8 ok (edit in side file) |
| `run5.mjs ctrlCPendingAfterExit` | 0/8 ok | 8/8 ok (both edits in side file) |
| `run5.mjs brokenEditsCtrlC` / `brokenEdits` | ok | 4/4, 3/3 (no spurious side file) |
| `run5.mjs reBreakCtrlC` / `twoWinInvCtrlC` | ok | 4/4, 4/4 |
| `run5.mjs freshAppend` / `freshConnect` / `freshDelete` / `sameContent` | ok, merged toast shown | 4/4 each, no toast |
| `run4.mjs ctrlCInv` / `freshMove`, `run2.mjs invSlow` | ok | 6/6 each (freshMove: no toast) |

New E2E cases: Ctrl-C soon after the host replaced a half-written file with the IDE finishing after
exit, with and without a second edit waiting for its write (side file holds the edits, stderr names
it, exit within 1.5 s), and a normal Ctrl-C (under 1 s, no side file, no warning).

## Round 6: unconfirmed write stuck after a racing confirm read

The round-5 check found that an unconfirmed write could stay unconfirmed for good. This happened
when one of our own writes landed while the 2 s confirm read was in flight, so the read returned
the content from before that write. The check that followed saw our own content and ended without
confirming. After that, `saved` was never sent again, windows kept re-applying old acknowledged edits
on later IDE saves, and the next Ctrl-C, even minutes later, left a spurious side file. The verifier's
store-level probe (`c2r5/stuck.mjs`, confirm window 200 ms, writes hammered at its deadline) hit it in
2/30 runs.

Fix (`src/file.js`, `confirmProvisional`): when the confirm read sees other content while the store
believes the file holds our latest write, it reads again after the settle delay. A change by another
program still ends the unconfirmed state through its own check. After the fix, `stuck.mjs` was stuck
in 0/50 runs, and a deterministic unit test covers the case. The shutdown warning is now shorter and
states the actual time since the broken file was replaced, e.g. "the editor replaced the broken
order.bpmn 0.6 s ago; its version was also saved to <side file> (in case another program finishes an
older save)".
