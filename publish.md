# How to publish a new version

Make sure you're logged into npm (`npm whoami`).

```bash
# 1. Bump version (choose one)
npm version patch   # 2.0.0 → 2.0.1
npm version minor   # 2.0.0 → 2.1.0
npm version major   # 2.0.0 → 3.0.0

# 2. Push the commit and tag
git push --follow-tags

# 3. Create a GitHub release
gh release create v$(node -p "require('./package.json').version") --generate-notes

# 4. Publish to npm
npm publish
```
