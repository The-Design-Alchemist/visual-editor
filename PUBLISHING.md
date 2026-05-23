# Publishing — handoff guide

This file is for the maintainer (Aaqil). It documents the steps needed to go
from "everything is green locally" to "the packages are live on npm." Read
this once, top to bottom, before pulling the trigger.

---

## Pre-flight (do this once)

### 1. npm account + scope

```bash
npm whoami        # confirm you're logged in as the account that owns @aaqiljamal
npm login         # if not
```

The scope `@aaqiljamal` on npm needs to be associated with your account. If
it isn't (first publish on this scope), the first `npm publish --access=public`
will create it.

Confirm:

```bash
curl -s https://registry.npmjs.org/-/user/org.couchdb.user:aaqiljamal | jq .
```

### 2. GitHub repo

The `gh` CLI on this machine is currently authed as **`The-Design-Alchemist`**,
not `aaqiljamal`. Either:

**Option A** — switch the auth so the repo lands under aaqiljamal:

```bash
gh auth login                # pick your aaqiljamal account
gh auth status               # verify "Active account: true" is aaqiljamal
```

**Option B** — publish under The-Design-Alchemist:

Update every `repository.url` field in the 5 package.json files + root
package.json + README.md + INSTALL.md to point at
`https://github.com/The-Design-Alchemist/visual-edit.git`. Search-and-replace
on `aaqiljamal/visual-edit` → `The-Design-Alchemist/visual-edit`.

**Option C** — create manually in the browser at github.com/new, then push.

Once the auth is settled and there are no uncommitted changes:

```bash
gh repo create aaqiljamal/visual-edit \
  --public \
  --description "Visual gestures → deterministic source edits for Next.js. Tailwind, CSS Modules, styled-components." \
  --source=. \
  --push
```

### 3. NPM_TOKEN as a GitHub secret

The release workflow (`.github/workflows/release.yml`) needs `NPM_TOKEN`
to publish:

```bash
# Create an "Automation" token at https://www.npmjs.com/settings/<your-name>/tokens
# Type: Automation (skips 2FA-on-publish prompt)

gh secret set NPM_TOKEN
# paste the token
```

---

## First publish (today's checklist)

### 1. Local verification

```bash
npm install                  # workspaces install
npm run build --workspaces --if-present
npm run test:server          # 129/129 expected
npm run test:mcp             # 7/7 expected
```

Anything red? Stop and fix before going further.

### 2. Commit + push to main

```bash
git add .
git commit -m "v0.2.0 — Mode B ready"
git push -u origin main
```

CI on the push should be green within a few minutes. Check:

```bash
gh run watch
```

### 3. The first publish — manual, not via the workflow

Because every package is at `0.2.0` and there are no changesets yet, the
release workflow won't publish on its own. The first publish is manual:

```bash
npm run build --workspaces --if-present

# Babel plugin and runtime and server first — next + mcp depend on them
cd packages/babel-plugin && npm publish && cd ../..
cd packages/runtime && npm publish && cd ../..
cd packages/server && npm publish && cd ../..
cd packages/next && npm publish && cd ../..
cd packages/mcp && npm publish && cd ../..
```

Each prompts for 2FA unless you used an Automation token via env:

```bash
NODE_AUTH_TOKEN=$NPM_TOKEN npm publish
# or:
echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > ~/.npmrc
```

Verify on each `npm publish`:

- Package size looks reasonable (~10–500KB, not multi-MB)
- The `tar tf` output shows `dist/` files, not `src/`
- Provenance is generated (visible in the publish output)

```bash
# After all 5 are up:
npm view @aaqiljamal/visual-edit-next
```

### 4. Subsequent releases — through changesets

For every change:

```bash
npx changeset           # describe the change + bump level (patch/minor/major)
# … commit + open PR + merge as normal …
```

Once the PR is on `main`, the release workflow creates a "chore: version
packages" PR. Merging *that* PR triggers the publish.

---

## Verification — does the install actually work?

In an unrelated empty directory:

```bash
mkdir /tmp/ve-smoke && cd /tmp/ve-smoke
npx create-next-app@latest --typescript --tailwind --app --no-src-dir \
  --turbopack --import-alias "@/*" --no-eslint --use-npm .

npm install --save-dev \
  @aaqiljamal/visual-edit-next \
  @aaqiljamal/visual-edit-babel-plugin

npx visual-edit-init
# Manually add <VisualEditOverlay /> to app/layout.tsx (the init prints the snippet)

npm run dev
# Open http://localhost:3000
# Hover any element → expect pink outline + box-model bands + source badge
```

If that works, the publish is real. If it doesn't, you missed a dist file,
a missing peer, or the exports field is wrong. The CI catches the test
failures but the install-from-fresh-project flow is only caught by this
smoke test.

---

## Rollback

If a published version is broken:

```bash
# Deprecate without unpublishing (you have 72h to unpublish; after that,
# you have to publish a new version)
npm deprecate @aaqiljamal/visual-edit-next@0.2.0 "broken — use 0.2.1"
```

Then bump (changeset + push) and republish.

---

## Common first-publish gotchas

| Symptom | Fix |
|---|---|
| `403 Forbidden — Public registration not allowed for this scope` | First publish needs `--access=public`. Verify `publishConfig.access: "public"` is in each package.json (it is). |
| `404 Not Found — @aaqiljamal/visual-edit-server` (from a consumer) | Publish order matters. babel-plugin + runtime + server must be on npm before `next` resolves them. |
| `ENOENT: no such file dist/index.js` | tsup didn't run before publish. Either run `npm run build` manually, or trust `prepublishOnly` (which `npm publish` invokes). |
| `error: missing types entry "./dist/index.d.ts"` | tsup's dts emit failed silently — usually a TS strictness error in source. Run `npm run build` standalone in that package to see the real error. |
