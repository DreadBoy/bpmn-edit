# bpmn-edit — workflow instructions

How work on this repo is planned, built, verified and released. Distilled from the user's instructions during v1 (2026-10-12 to 2026-10-15). The product spec is `bpmn-edit.md`, the plan is `PLAN.md`, decisions are in `docs/decisions.md`, the release procedure is in `docs/release-procedure.md`.

## Start
- Work from `PLAN.md`; write new work into it before starting. Small steps with checkboxes; a step is ticked only after it is verified.
- Open questions that depend on observed behaviour are never left as a list or put back to the user ("I can't answer them for you"). Each becomes a measure-and-decide step in the plan: experiment, thresholds, decision recorded in `docs/decisions.md`, then implementation.
- Scope tightly per version. Features that prove the MVP come first; cross-platform, extra browsers and polish come after, as an automatic test matrix rather than per-test code. The user may reorder the plan at any time — apply it and commit PLAN.md.
- New ideas raised mid-flight go into a later-version section of PLAN.md, not the current work. When the user asks "whatever is easier / best for UX", recommend one option with reasons.

## Roles
- The main agent is coordinator and supervisor only. It never does the implementation itself.
- Each task goes to a supervising agent A. A understands the task, spawns implementer A1, then a **fresh** verifier A2 with no implementation context. A1 → A2 loops until A2 reports HAPPY; only then A reports back.
- Run independent tasks in parallel (agents A, B, …), each in its own git worktree. The coordinator merges, re-runs the suites, and resumes agents that hand back early or interim.
- The coordinator commits each verified step itself, with PLAN.md updated (status, one-line verification summary, backlog items).

## Verification
- Only an end-to-end check done as a real user would counts: real CLI, real browser, real disk, real `git diff`. Nothing mocked on the user path. Unit and integration tests are a means, not the verification.
- Verifiers write their own scenarios and do exploratory testing, not just re-run the implementer's tests.
- Long verify loops are worth it while they find real bugs, especially data loss or corruption. Quality over speed — don't rush or cut corners.
- But cap them: after a few rounds (about 3), triage. Only silent data loss, invalid/corrupt output or a broken release blocks; a blocker gets a targeted fix plus re-test, not another full round. Everything else goes to the backlog with repro and severity. Rare narrow-timing races don't have to be fixed in the current version; common-path data loss always does.
- Watch for the 20-80 long tail: when a step turns into an open-ended edge-case hunt, say so and propose the simple MVP version or a stopping point.

## Usage limits and autonomy
- Never get close to 100% of any limit — that stalls work and needs the user.
- Watch usage with the `claude-usage` skill (5% steps), re-arm it when it expires, stop it when nothing runs.
- 5-hour window: at 80% pause (start nothing new); at 90% force-stop subagents. Resume after the reset.
- Weekly: stay at or below ~70% (stop around 68%) to leave the user headroom, unless the user explicitly lifts it ("burn all weekly until reset") — such a lift lasts only until that reset.
- Check window boundaries against the user's schedule; a window the user won't use may be used up to 80–90%. When usage is low, keep working — don't idle.
- When the user leaves ("off to bed", "back in a few hours"), keep working on everything that needs no approval and queue what does.

## Talking with the user
- A surprised question about runtime ("still working on that?", "are you stuck?") is curiosity, not impatience. Answer it honestly, including own coordination mistakes; don't cut scope or quality because of it.
- "Just talking" / "no need to change" means discuss only. Don't add scope the user didn't ask for.
- On "what's the status": done, in progress, blocked and why — with evidence (test counts, commits). Correct the user's wrong assumptions instead of agreeing.
- End a phase by asking before starting the next one; the next version starts only on explicit go-ahead.

## Git, release, safety
- Commit identity: author **and** committer `Matic Leva <vertical3life@gmail.com>` (repo-local git config). Never the work email. Check `git log --format='%an <%ae> | %cn <%ce>'` before any push. PLAN.md may mention Claude; commits and PRs never do.
- Stage files explicitly — never `git commit -a` while agents work in the repo.
- History rewrites, the first public push and publishing need explicit approval; research and document the procedure in the meantime. The repo is public: pushing verified commits to main is fine (SSH uses the DreadBoy key via repo-local `core.sshCommand`); never force-push it, push only `main`.
- Publish only fully verified code (a version number can never be reused). The user does account-side steps (npm login, first publish, trusted-publisher settings); give exact settings and timing.
- Never print or commit secrets. Don't kill the user's own processes — tell them how to stop them.
