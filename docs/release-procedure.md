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
  - Node 24 via `actions/setup-node` is the simplest route; glyphmark relies on it bundling a new enough npm, which is not verified here.
  - Node 22 ships npm 10.x, which is too old.
- **Provenance** is generated automatically for a public repo and public package. `NPM_CONFIG_PROVENANCE=true` just makes it explicit.
- **`repository.url` must match the GitHub repo exactly**, including case: `git+https://github.com/DreadBoy/bpmn-edit.git`.
- **Trusted-publisher configs are strict:**
  - not validated when saved;
  - can't be edited, only deleted and recreated;
  - expire if not used for a successful publish within 2 days.
- **Allowed actions:** configs created after 2026-09-03 reportedly default to "stage publish" only. Enable direct `npm publish` so the workflow can publish unattended. Check the UI wording; this is unverified.

## Owner steps (npmjs.com / GitHub)

1. Make sure https://github.com/DreadBoy/bpmn-edit is public and holds the release commit.
2. From a clean checkout of that commit, do the first publish:
   - run `npm login` (with 2FA);
   - run `npm publish --access public`.

   This first version has no provenance; that's expected.
3. On npmjs.com, open the package `bpmn-edit`, then Settings, then Trusted Publisher, and choose GitHub Actions. Fill in:
   - user `DreadBoy`;
   - repo `bpmn-edit`;
   - workflow `release.yml`;
   - no environment;
   - direct publish allowed.
4. Within 2 days, release the next version through the workflow. Confirm the provenance badge on the package page; `npm audit signatures` can also check it.
5. Set Publishing access to "Require two-factor authentication and disallow tokens", and revoke any tokens.

## In the repo

- **`package.json`:** `repository`, `homepage`, `bugs`, and `publishConfig.access: public` (or `--access public` on the publish command).
- **`.github/workflows/release.yml`:**
  - Trigger: push to main, plus `workflow_dispatch`.
  - `check` job: `npm ci` + unit tests.
  - `publish` job:
    - `permissions: { contents: read, id-token: write }`;
    - GitHub-hosted runner;
    - Node 24 via `actions/setup-node` **without `registry-url`**, as a precaution: its `NODE_AUTH_TOKEN` placeholder may interfere with OIDC;
    - no `NPM_TOKEN`;
    - guard with `npm view bpmn-edit@<version>` so a push without a version bump is a no-op.
- **`.github/workflows/version.yml`:** a manual version bump that then dispatches Release, as in glyphmark.

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
