# Releasing

1. **Node harness green**: `bash tests/run.sh` (pure-logic suites + syntax
   check of every PJSR file, bundled or not). The Release workflow runs the
   same harness before building and fails the release if it is red — do not
   tag on a red harness.
2. **PixInsight headless gates** (run each with
   `<PI-exe> -n --automation-mode --force-exit -r=<abs path>`, read the JSON
   marker in the system temp directory, `ok` must be true):
   - construct test — `SI_CONSTRUCT_TEST=1` with `pjsr/SkyIntruders.js`:
     every dialog builds, the handlers round-trip, both languages
     (`skyintruders-construct.json`);
   - `tests/selftest-pi.js` — include chain, SGP4 and NetworkTransfer on the
     real engine (`skyintruders-selftest.json`); `tests/selftest-integration.js`
     for the Treasure Hunt render path (`skyintruders-integration.json`);
   - **reference night** — `SI_HEADLESS_LIB=1` with `tests/run-night-testset.js`
     on the reference frames, twice: on the release candidate and on the
     previous tag, **the same day**. Compare the two `si-night-testset.json`
     (events, names, confidences, fit, movers) and explain every difference.
     Comparing against an old saved run is meaningless: the identities depend
     on the TLE set, and TLE age changes them — a satellite named on a
     day-fresh element may be a prediction-only crosser on a week-old one —
     so only a same-day replay of the previous tag isolates what the code
     changed.
   - Two-gate rule on top: a clean console log (grep
     `error|failed|no such|skipped` and explain every hit) AND the report
     compared with the previous tag's same-day report.
3. Update `CHANGELOG.md` (with the validation evidence) + the README version badge.
4. **Re-verify `docs/support-kb.md` against the code, 100%.** It is the support
   agent's only reference, and a KB that lags the code is worse than none. Any
   changed default, threshold, label, message, file path, catalog or failure mode
   must be reflected there — including the `Applies to` version line.
5. **Re-read `docs/ARCHITECTURE.md` and `docs/TREASURE-HUNT.md` against the
   code, the same way**: every constant, default, file name, window name,
   cache key version and pipeline step named there must match what the code
   at the tag does. They are the contributor's map; a stale map sends the
   next fix to the wrong place.
6. Verify the git author is `caelo-works` (`git config user.name`). Never rely on
   the active `gh` account (it can flip at any time): inject the caelo-works token
   per command instead — `GH_TOKEN="$(gh auth token --user caelo-works)" gh …` for
   `gh`, and for git
   `GH_TOKEN="$(gh auth token --user caelo-works)" git -c credential.https://github.com.helper='!gh auth git-credential' push …`.
7. Commit, push `main` first, then tag and push the tag (so CI on `main` has run
   before the tag exists):
   ```
   git commit -am "vX.Y.Z: <headline>"
   GH_TOKEN="$(gh auth token --user caelo-works)" git -c credential.https://github.com.helper='!gh auth git-credential' push origin main
   git tag -a vX.Y.Z -m "vX.Y.Z — <headline>"
   GH_TOKEN="$(gh auth token --user caelo-works)" git -c credential.https://github.com.helper='!gh auth git-credential' push origin vX.Y.Z
   ```
8. The Release workflow attaches `dist/<Name>-X.Y.Z.zip` + `update-package.json`.
9. **Notify the site agent**: comment on the tracking issue in
   `caelo-works/pixinsight-scripts` with the release URL, the zip **sha1** (from the
   published `update-package.json`, not your local build), and `piVersionRange`.
