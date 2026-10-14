# Release procedure: npm Trusted Publishing for `bpmn-edit`

Researched 2026-10-13. Sources:
- https://docs.npmjs.com/trusted-publishers
- https://docs.npmjs.com/generating-provenance-statements
- https://docs.npmjs.com/policies/unpublish
- https://github.com/npm/cli/issues/8544
- Reference workflow: https://github.com/DreadBoy/glyphmark/blob/main/.github/workflows/release.yml

## Key facts

- **The first version must be published manually.** The trusted-publisher settings live on the package's settings page, and that page only exists once the package is on the registry. npm/cli#8544 ("Allow publishing initial version with OIDC") is still open.
- **A `name@version` can never be reused**, even after it is unpublished. So publish the real first version, not a placeholder. Unpublishing is free only within 72 h.
- **Tool versions:** OIDC publishing needs npm CLI ≥ 11.5.1 and Node ≥ 22.14.
  - Node 24 via `actions/setup-node` is the simplest route, because Node 24 bundles a new enough npm. Measured 2026-10-14: Node 24.21.0 ships npm 11.19.0. `release.yml` also checks the version before publishing.
  - Node 22 ships npm 10.x, which is too old.
- **Provenance** is generated automatically for a public repo and public package. `NPM_CONFIG_PROVENANCE=true` just makes it explicit.
- **`repository.url` must match the GitHub repo exactly**, including case: `git+https://github.com/DreadBoy/bpmn-edit.git`.
- **Trusted-publisher configs are strict:**
  - not validated when saved;
  - can't be edited, only deleted and recreated;
  - expire if not used for a successful publish within 2 days.
- **Allowed actions:** configs created after 2026-09-03 reportedly default to "stage publish" only. Enable direct `npm publish` so the workflow can publish unattended. Check the UI wording; this is unverified.

## Owner steps (npmjs.com / GitHub)

1. From a clean checkout of the local release commit (the one about to be pushed), do the first publish:
   - run `npm login` (with 2FA);
   - run `npm publish --access public`.

   This first version has no provenance; that's expected.
2. Push main to https://github.com/DreadBoy/bpmn-edit and make the repo public. Release runs; its `publish` job finds 1.0.0 already on npm and does nothing.
   - Alternative: push first, then publish. That push's Release run then fails at `publish` with ENEEDAUTH. The failure is expected and harmless.
3. On npmjs.com, open the package `bpmn-edit`, then Settings, then Trusted Publisher, and choose GitHub Actions. Fill in:
   - user `DreadBoy`;
   - repo `bpmn-edit`;
   - workflow `release.yml`;
   - no environment;
   - direct publish allowed.
4. Within 2 days, release the next version through the workflow. Confirm the provenance badge on the package page; `npm audit signatures` can also check it.
5. Set Publishing access to "Require two-factor authentication and disallow tokens", and revoke any tokens.

## In the repo

- **`package.json`:** `repository`, `homepage`, `bugs`, and `publishConfig.access: public` (the workflow also passes `--access public`).
- **`.github/workflows/release.yml`** (concurrency group `release`, never cancelled):
  - Trigger: push to main, plus `workflow_dispatch`.
  - `check` job, on **`macos-latest`**:
    - `npm ci`, then `npm test` (unit tests);
    - `npm run vendor` must leave `web/vendor/` unchanged. This catches a bpmn-js bump in the lockfile that was not re-vendored.
    - Why macOS: v1 supports macOS only, and the server can't start on Linux yet (see "Linux" below). On ubuntu every server test fails, and the share/ws test files hang rather than fail, so the job has `timeout-minutes: 15`.
  - `publish` job, needs `check`:
    - `ubuntu-latest`, which is GitHub-hosted (Trusted Publishing rejects self-hosted runners);
    - `permissions: { contents: read, id-token: write }`;
    - Node 24 via `actions/setup-node` **without `registry-url`**, as a precaution: its `NODE_AUTH_TOKEN` placeholder may interfere with OIDC;
    - no `NPM_TOKEN` and no `NODE_AUTH_TOKEN` anywhere.
  - `publish` steps, in order:
    1. Print `node`/`npm` versions, and fail with `::error::` if npm is older than 11.5.1. Node 24.21.0 ships npm 11.19.0 (measured in the `node:24` image, 2026-10-14), so this is only a guard. It does not `npm install -g npm`, so the publish uses the npm the Node release ships.
    2. Probe `npm view "<name>@<version>" version`, with the name and version read from `package.json`. If the version is already on npm, all later steps are skipped, so a push without a version bump is a no-op.
    3. Run `npm pack --dry-run` so the log lists the tarball contents.
    4. Run `npm publish --access public` with `NPM_CONFIG_PROVENANCE=true`.
  - No `npm ci` in `publish`: there's no build step and no `prepack`/`prepublishOnly` script, since `web/vendor` is committed.
- **`.github/workflows/version.yml`** (manual `workflow_dispatch`, input `version`):
  1. Validate the input. It must be a plain `X.Y.Z`, greater than the current version (compared numerically with node, no dependencies).
     - Prerelease suffixes (`-beta.1`) are rejected: `npm publish` without `--tag` fails for them under npm 11.
     - Build metadata (`+build`) is rejected: npm strips it.
  2. Run `npm version <v> --no-git-tag-version`. This rewrites the version in `package.json` and in both fields of `package-lock.json`, and nothing else. glyphmark uses `npm pkg set` + `npm install`, which re-resolves dependencies and can add unrelated lockfile churn. No git tag is created; the npm registry is the release record.
  3. Commit `bump version to <v>` and push it to the dispatched ref.
     - Author and committer: the GitHub user who dispatched the workflow (`github.actor`, `<actor_id>+<actor>@users.noreply.github.com`), as in glyphmark.
     - So bump commits carry that noreply address, not `vertical3life@gmail.com`.
     - No `--no-verify` is needed: there's no `prepare` script and no git hooks.
  4. On main, run `gh workflow run release.yml --ref main`. This is needed because pushes made with `GITHUB_TOKEN` don't trigger workflows.
- **First push:** follow the owner steps in order:
  1. Publish 1.0.0 manually.
  2. Push main. Release's `publish` job then sees 1.0.0 on npm and does nothing.

  If main is pushed first, that one Release run fails at `publish` with ENEEDAUTH, which is harmless. Either way, the first workflow publish is the next bump, which goes through `version.yml`.

### E2E in CI: not now

Decided 2026-10-14: E2E (`npm run test:e2e`) stays a local gate. No CI job.

- **Linux:** the server does not start there at all. `wildcardListenerOn()` in `src/server.js` probes `0.0.0.0`/`::` after binding `127.0.0.1`/`::1`. Linux refuses that bind with EADDRINUSE; macOS allows it. So every port looks taken, and `bpmn-edit` exits with "No free port found starting at 3000". This was measured in `node:24` (Linux arm64), for both the CLI and the unit tests.
  - When the probe was skipped on Linux in a scratch copy, 254/256 unit tests passed as non-root, which is how GitHub runners run.
    - Both failures are cases of the probe's own test (`share.test.js:402`, `*:0.0.0.0` and `*:[::]`).
    - A write-error test also fails, but only when run as root (e.g. a default Docker container).
  - On Linux the probe is redundant anyway: there, binding the loopback address already fails if another program listens on the wildcard address.
  - Fixing this (`src/server.js`) is a product change, tracked outside S12. Linux is outside v1 support, but `npx bpmn-edit` on Linux currently fails outright.
- **Tunnel specs:** `s7-share-tunnel` and `s8-keepalive-tunnel` need real Cloudflare quick tunnels, which are rate-limited per network. They honour `BPMN_EDIT_SKIP_TUNNEL_E2E=1`. Every other spec runs offline.
- **Timing:** several specs are load-sensitive (S10 backlog). An unmeasured job that flakes on shared runners would teach people to ignore red runs.
- **Follow-up (measure, then decide):** a separate, non-blocking macOS workflow (`workflow_dispatch` or PR):
  1. `npx playwright install chrome`;
  2. `BPMN_EDIT_SKIP_TUNNEL_E2E=1 npx playwright test --project=chrome`;
  3. run it a few times on `macos-latest`. Make it a gate only if it is green and stable there.

  It can't be measured before the repo is on GitHub. A recent `act` (0.2.89) can dry-run both workflows (`act -n -P ubuntu-latest=node:24`), but it has no macOS runner and no OIDC token. So it can't run the macOS check or the e2e job, and it can't run the publish.

## Common failure modes

- **ENEEDAUTH, or a misleading 404 on publish.** Usual causes:
  - npm too old;
  - `id-token: write` missing;
  - workflow filename, owner or repo mismatch (case-sensitive);
  - environment mismatch;
  - self-hosted runner;
  - config expired after 2 days unused.
- **Provenance rejected:** `repository.url` doesn't match the repo.
- **Renaming the workflow file:** publishing breaks until the trusted-publisher config is recreated.
