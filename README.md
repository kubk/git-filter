# git-filter

Create a filtered copy of a git repository - keeping only the files you choose, with full commit history preserved.

Useful for publishing parts of a private repository as open source - for example, publishing the frontend from a private full-stack repo without exposing the API.

## Install

Requires Node.js 24+.

```bash
npm install -g git-filter
```

Or run directly:

```bash
npx git-filter config.json
```

## Usage

Create a `config.json`:

```json
{
  "forceReCreateRepo": false,
  "followByLogFile": true,
  "sourceRepoPath": ".",
  "targetRepoPath": "../my-public-repo",
  "allowedPaths": ["frontend/*", "README.md"],
  "ignoredPaths": ["backend/*"]
}
```

Run it:

```bash
git-filter config.json
```

A new git repo appears at `targetRepoPath` with only the matching files - every commit, author, and date intact.

## Push to a remote

Set `targetRemote` to push the result after the export, for example from CI:

```json
{
  "forceReCreateRepo": true,
  "targetRepoPath": "../my-public-repo",
  "targetRemote": "git@github.com:me/my-public-repo.git",
  "targetBranch": "main",
  "allowedPaths": ["frontend/*", "README.md"]
}
```

`targetBranch` defaults to `main`. The push is forced, because changing `allowedPaths` or `ignoredPaths` rewrites the filtered history. A local `targetRemote` path is resolved relative to `targetRepoPath`.

With `forceReCreateRepo` the filtered history is the same on every run, so CI needs no saved state. Check out the full history (`fetch-depth: 0` with `actions/checkout`).

## Used by

- [MemoCard](https://github.com/kubk/memo-card) - Telegram mini app for improving memory with spaced repetition
- [Nomad Expense](https://github.com/kubk/nomad-expense) - Family expense tracker as a Telegram mini app
- [Just Block](https://github.com/just-block/just-block.github.io) - A Chrome extension to quickly block distracting websites

## Acknowledgements

Fork of [open-condo-software/gitexporter](https://github.com/open-condo-software/gitexporter):

- **No native dependencies** - uses the plain `git` CLI instead of the native `nodegit` addon
- **Modern Node.js support**
- **Fast** - incremental exports are about 22x faster, from 9.9s to 0.45s
