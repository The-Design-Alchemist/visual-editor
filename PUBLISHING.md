# Publishing

**Status:** All 5 packages live on npm. Auto-release via changesets is wired up
and verified end-to-end (first changeset → merged Version PR → auto-publish
worked on 2026-05-23). For ongoing releases, you only need the **Ship a change**
section below.

---

## Ship a change (the normal flow)

```bash
# 1. Edit code, save.

# 2. Describe what changed (interactive — picks bump level + packages):
npx changeset
# (creates .changeset/<random-name>.md)

# 3. Commit + push (or open a PR and merge it):
git add . && git commit -m "describe the change" && git push

# 4. Wait ~30 seconds. The Release workflow opens a "chore: version packages" PR.

# 5. Merge that PR. Release workflow re-runs and auto-publishes to npm.
```

That's the whole loop. You never run `npm publish` manually for this.

Versions move in sync only when the changeset mentions multiple packages.
A changeset that only mentions `@aaqiljamal/visual-editor-next` will bump
*only* `next` — the other 4 stay at their current version because their bytes
didn't change. The `linked` array in `.changeset/config.json` aligns versions
only when several packages bump together.

---

## Emergency manual publish (when CI is down or you need to bypass)

```bash
npm whoami                          # confirm aaqiljamal
cd packages/babel-plugin && npm publish && cd ../..
cd packages/runtime     && npm publish && cd ../..
cd packages/server      && npm publish && cd ../..
cd packages/next        && npm publish && cd ../..
cd packages/mcp         && npm publish && cd ../..
```

Order matters: `next` and `mcp` depend on the others. Each `prepublishOnly`
rebuilds `dist/` automatically. You need a valid token in `~/.npmrc`.

---

## Token rotation

The NPM_TOKEN currently in `~/.npmrc` + GitHub secret was generated on
2026-05-23 and **was pasted into a chat conversation** during setup. Rotate it
before the next release for a fresh one that never leaves your machine:

```bash
# 1. Delete the old token at https://www.npmjs.com/settings/aaqiljamal/tokens
# 2. Generate a new one (Granular, Read+write, @aaqiljamal scope, Bypass 2FA, 90d)
# 3. Update both locations:
sed -i '' 's|_authToken=.*|_authToken=PASTE_NEW_TOKEN|' ~/.npmrc
gh secret set NPM_TOKEN  # paste new token at the prompt; input is hidden
```

The 90-day expiration is npm policy for granular tokens; you'll rotate ~4x/year.

---

## Initial setup (already done — for reference)

These steps ran on 2026-05-23 and don't need to happen again:

| Step | What | How verified |
|---|---|---|
| 1 | npm account exists at `aaqiljamal` | `npm whoami` returns `aaqiljamal` |
| 2 | `@aaqiljamal` scope claimed | First `npm publish` of v0.2.0 succeeded |
| 3 | Granular access token generated | Token in `~/.npmrc` + GitHub `NPM_TOKEN` secret |
| 4 | GitHub Actions permitted to create PRs | `gh api repos/.../actions/permissions/workflow` returns `default_workflow_permissions: write` |
| 5 | First 5-package publish | `npm view @aaqiljamal/visual-editor-next` returns 0.2.0 |
| 6 | Auto-release flow validated | Changeset → Version PR → merge → 0.2.1 published |

---

## Gotchas we hit (and the durable fixes)

| Symptom | Cause | Fix (already applied) |
|---|---|---|
| Release fails: "GitHub Actions is not permitted to create or approve pull requests" | Repo default since GitHub tightened defaults | `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true` |
| Release succeeds but no Version PR appears | `.changeset/*.md` was gitignored | `.gitignore` now keeps them tracked |
| Release publish step 404s with "Not found" on PUT | Two distinct causes — see below | Set both `NPM_TOKEN` *and* `NODE_AUTH_TOKEN` env in workflow; remove `NPM_CONFIG_PROVENANCE` until Trusted Publishing is set up |
| CI build fails with "Cannot find module @aaqiljamal/visual-editor-server" | `npm run build --workspaces` doesn't respect topological order | Root `build` script chains packages explicitly: babel-plugin → runtime → server → next → mcp |
| `npm warn publish "repository.url" was normalized` | npm wants `git+https://` prefix | All package.json `repository.url` use `git+` prefix |

### The two distinct 404 causes

1. **NODE_AUTH_TOKEN missing.** `actions/setup-node@v4` with `registry-url`
   writes `~/.npmrc` like `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`.
   npm reads that env var; if it's unset, the substitution yields an empty
   string and the PUT 404s. The workflow now sets *both* `NPM_TOKEN`
   (what changesets/action reads internally) and `NODE_AUTH_TOKEN` (what npm
   publish itself reads via the .npmrc template) to the same secret.

2. **Provenance + no Trusted Publisher.** With `NPM_CONFIG_PROVENANCE: "true"`,
   npm requires the package to be registered as a Trusted Publisher
   (https://docs.npmjs.com/trusted-publishers). Since our packages were
   bootstrapped with a local publish (not via CI), there's no trust
   relationship — npm 404s the PUT even though OIDC signs the provenance
   statement successfully against sigstore. Removing the env var falls back
   to plain token auth, which works.

---

## Enabling Trusted Publishing (future cleanup)

Provenance is a real security win — proves the package was built from the
git commit and CI environment claimed. To enable:

1. For each package on npmjs.com → package settings → **Trusted Publishers**:
   - Repository owner: `The-Design-Alchemist`
   - Repository: `visual-editor`
   - Workflow filename: `release.yml`
   - Environment: (leave blank)
2. In `.github/workflows/release.yml`, add back:
   ```yaml
   NPM_CONFIG_PROVENANCE: "true"
   ```
3. Publish a new patch via the normal flow. The provenance badge will appear
   on the npm page for each package.

Five repeats of the npmjs Trusted Publisher form. ~10 minutes total.

---

## Common future failure modes

| Symptom | Try |
|---|---|
| Release fails 401 / token expired | Rotate NPM_TOKEN (see Token rotation section). 90-day expiration. |
| Release fails 403 / scope permission | Token was generated without `@aaqiljamal` scope checked. Re-generate. |
| Version PR doesn't include all expected packages | Changeset markdown only mentioned the ones it bumped. Add more `"@scope/pkg": patch` lines to bump siblings. |
| Spurious "no changesets" status check on PR | The PR doesn't include a `.changeset/*.md` file. Add one before merging, or merge as a chore that needs no version bump. |
| Local `npm publish` works but CI doesn't | First check both env vars (`NPM_TOKEN` + `NODE_AUTH_TOKEN`) are present in the Release workflow's `env:` block. |
