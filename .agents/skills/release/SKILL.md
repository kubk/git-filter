---
name: release
description: Release a new git-filter version to npm and GitHub, or fix a failed release. Use when bumping the version, publishing, or debugging the release workflow.
---

# Release

1. Bump the version and tag it: `npm version patch` (or `minor` / `major`). This commits `package.json` and creates a matching `vX.Y.Z` tag.
2. Push both: `git push --follow-tags`.
3. Watch `.github/workflows/release.yml` with `gh run watch`, then confirm with `npm view git-filter version`.

The workflow checks that the tag matches `package.json`, runs typecheck, lint and tests, builds `dist/` (via `prepublishOnly`), publishes to npm, then creates the GitHub release. It skips a version that's already on npm, so a release that failed halfway can be retried by moving the tag to the fixed commit: `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`.

## npm access

Publishing uses npm trusted publishing (OIDC from GitHub Actions), not a token. The package has a trusted publisher on npmjs.com (package Settings → Trusted Publisher → GitHub Actions, `kubk/git-filter`, `release.yml`). npm asks for a 2FA code when saving it.
