# git-filter

Create a filtered copy of a git repository - keeping only the files you choose, with full commit history preserved.

Useful for publishing parts of a private repository as open source - for example, publishing the frontend from a private full-stack repo without exposing the API.

## Install

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
  "forceReCreateRepo": true,
  "sourceRepoPath": ".",
  "targetRepoPath": "../my-public-repo",
  "allowedPaths": ["packages/frontend/*", "README.md"],
  "ignoredPaths": ["packages/frontend/.env"]
}
```

Run it:

```bash
git-filter config.json
```

A new git repo appears at `targetRepoPath` with only the matching files - every commit, author, and date intact.

## Used by

- [MemoCard](https://github.com/kubk/memo-card) - Telegram mini app for improving memory with spaced repetition
- [Nomad Expense](https://github.com/kubk/nomad-expense) - Family expense tracker as a Telegram mini app
- [Just Block](https://github.com/just-block/just-block.github.io) - A Chrome extension to quickly block distracting websites

## Acknowledgements

Fork of [open-condo-software/gitexporter](https://github.com/open-condo-software/gitexporter):

- **No native dependencies** - uses the plain `git` CLI instead of the native `nodegit` addon
- **Modern Node.js support**
- **Fast** - incremental exports are about 22x faster, from 9.9s to 0.45s
