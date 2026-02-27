# gitexporter-lite

Create a filtered copy of a git repository — keeping only the files you choose, with full commit history preserved.

Useful when you develop in a private monorepo but want to publish parts of it as open source.

## Install

```bash
npm install -g gitexporter-lite
```

Or run directly:

```bash
npx gitexporter-lite config.json
```

## Usage

Create a `gitexporter.config.json`:

```json
{
  "forceReCreateRepo": true,
  "sourceRepoPath": ".",
  "targetRepoPath": "../my-public-repo",
  "allowedPaths": ["packages/frontend/*", "README.md"],
  "ignoredPaths": ["packages/frontend/.env"]
}
```

Run it:

```bash
gitexporter-lite gitexporter.config.json
```

A new git repo appears at `targetRepoPath` with only the matching files — every commit, author, and date intact.

## Acknowledgements

Fork of [open-condo-software/gitexporter](https://github.com/open-condo-software/gitexporter) with `nodegit` (native C++ addon, unmaintained, won't compile on Node 18+) replaced by plain `git` CLI calls. Zero native dependencies, works on any Node version.
