# Q2: browser edit racing a save made on disk (IDE)

Measurements for `PLAN.md` Q2, taken on the code as it was after Q1 (commit `0fd8d5a`), before any
change for Q2. Decision and the change are in `docs/decisions.md` (section Q2); the numbers after the
change are at the end of this file.

## Method

`test/e2e/q2-ide-race.measure.spec.js` (not part of the regular suite; run with
`LOCAL_BPMN_MEASURE=1 LOCAL_BPMN_MEASURE_OUT=<dir> npx playwright test q2-ide-race.measure`).

- Real CLI (`node bin/local-bpmn.js`, default write debounce 250 ms, settle delay 150 ms), Google Chrome
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
4. **Shutdown** (d): `bin/local-bpmn.js` `shutdown()` calls `store.unwatch()`, which cancels the
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
- No host stderr warnings in any trial (nothing was overwritten or kept aside).

An intermediate run (before shutdown re-checked the file) had a-c identical and d at 0/10 merged,
10/10 "disk change kept, browser version saved next to it" (`order.local-bpmn-unsaved-<time>.bpmn`):
that is now the fallback when no window is left to re-apply the edit (covered by
`test/e2e/q2-ide-race.spec.js`).
