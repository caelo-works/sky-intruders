# Releasing

1. **Validate** (two gates, always): (1) clean PI/console log — grep
   `error|failed|no such|skipped` and explain every hit; (2) outputs match the
   baseline (report compared against a known-good reference night).
2. Update `CHANGELOG.md` (with the validation evidence) + the README version badge.
3. Verify the git author is `caelo-works` and `gh auth status` shows caelo-works ACTIVE
   (`gh auth switch -u caelo-works && gh auth setup-git` — the active account can flip).
4. Commit, then tag and push:
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z — <headline>"
   git push origin main vX.Y.Z
   ```
5. The Release workflow attaches `dist/<Name>-X.Y.Z.zip` + `update-package.json`.
6. **Notify the site agent**: comment on the tracking issue in
   `caelo-works/pixinsight-scripts` with the release URL, the zip **sha1** (from the
   published `update-package.json`, not your local build), and `piVersionRange`.
