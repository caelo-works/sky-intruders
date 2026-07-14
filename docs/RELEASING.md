# Releasing

1. **Validate** (two gates, always): (1) clean PI/console log — grep
   `error|failed|no such|skipped` and explain every hit; (2) outputs match the
   baseline (report compared against a known-good reference night).
2. Update `CHANGELOG.md` (with the validation evidence) + the README version badge.
3. **Re-verify `docs/support-kb.md` against the code, 100%.** It is the support
   agent's only reference, and a KB that lags the code is worse than none. Any
   changed default, threshold, label, message, file path, catalog or failure mode
   must be reflected there — including the `Applies to` version line.
4. Verify the git author is `caelo-works` and `gh auth status` shows caelo-works ACTIVE
   (`gh auth switch -u caelo-works && gh auth setup-git` — the active account can flip).
5. Commit, then tag and push:
   ```
   git tag -a vX.Y.Z -m "vX.Y.Z — <headline>"
   git push origin main vX.Y.Z
   ```
6. The Release workflow attaches `dist/<Name>-X.Y.Z.zip` + `update-package.json`.
7. **Notify the site agent**: comment on the tracking issue in
   `caelo-works/pixinsight-scripts` with the release URL, the zip **sha1** (from the
   published `update-package.json`, not your local build), and `piVersionRange`.
