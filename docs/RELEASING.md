# Releasing

1. **Validate** (two gates, always): (1) clean PI/console log — grep
   `error|failed|no such|skipped` and explain every hit; (2) outputs match the
   baseline (report compared against a known-good reference night).
2. Update `CHANGELOG.md` (with the validation evidence) + the README version badge.
3. **Re-verify `docs/support-kb.md` against the code, 100%.** It is the support
   agent's only reference, and a KB that lags the code is worse than none. Any
   changed default, threshold, label, message, file path, catalog or failure mode
   must be reflected there — including the `Applies to` version line.
4. **Run the Node harness and require it green**: `bash tests/run.sh` (pure-logic
   suites + syntax check of every PJSR file, bundled or not). The Release workflow
   runs the same harness before building and fails the release if it is red — do
   not tag on a red harness.
5. Verify the git author is `caelo-works` (`git config user.name`). Never rely on
   the active `gh` account (it can flip at any time): inject the caelo-works token
   per command instead — `GH_TOKEN="$(gh auth token --user caelo-works)" gh …` for
   `gh`, and for git
   `GH_TOKEN="$(gh auth token --user caelo-works)" git -c credential.https://github.com.helper='!gh auth git-credential' push …`.
6. Commit, push `main` first, then tag and push the tag (so CI on `main` has run
   before the tag exists):
   ```
   git commit -am "vX.Y.Z: <headline>"
   GH_TOKEN="$(gh auth token --user caelo-works)" git -c credential.https://github.com.helper='!gh auth git-credential' push origin main
   git tag -a vX.Y.Z -m "vX.Y.Z — <headline>"
   GH_TOKEN="$(gh auth token --user caelo-works)" git -c credential.https://github.com.helper='!gh auth git-credential' push origin vX.Y.Z
   ```
7. The Release workflow attaches `dist/<Name>-X.Y.Z.zip` + `update-package.json`.
8. **Notify the site agent**: comment on the tracking issue in
   `caelo-works/pixinsight-scripts` with the release URL, the zip **sha1** (from the
   published `update-package.json`, not your local build), and `piVersionRange`.
