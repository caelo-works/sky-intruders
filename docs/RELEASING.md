# Releasing

1. **Node harness green**: `bash tests/run.sh` (pure-logic suites + syntax
   check of every PJSR file, bundled or not). The Release workflow runs the
   whole CI before building and opens no draft if it is red — do not tag on a
   red harness.
1b. **Documentation pages**: after any change to `docs/pidoc/*.pidoc`, run
   `scripts/build-script-doc.sh` (PixInsight closed; it compiles headless) and
   commit the regenerated `doc/scripts/` pages with the source. Re-read both
   pages against the code like the KB (step 4): hosts, what is sent, files,
   temp files, programs, the attribution option.
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
3. Update `CHANGELOG.md` (with the validation evidence) + the README version
   badge. The Release workflow refuses a tag without a `## [X.Y.Z]` section.
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
8. The Release workflow runs CI, builds, runs `check-package.sh`, and opens a
   **draft** release with `dist/SkyIntruders-X.Y.Z.zip` + `update-package.json`,
   **unsigned**. A draft is invisible to users and to the update site.
9. **Signing and publishing are not done here.** The CaeloWorks signing run
   (`scripts/sign-releases.sh` in `caelo-works/pixinsight-scripts`, run by the
   key holder) checks out the tag, runs this repo's `scripts/sign-package.sh`
   on the draft's zip, uploads the signed zip and sidecar over the draft's,
   and publishes. Then the signed hand gate: install from the update
   repository with **Allow execution of unsigned scripts** turned OFF and
   check that the script starts.
10. **Notify the site agent** with the release URL, the zip **sha1** from the
   **signed** `update-package.json` (a signed zip is not reproducible: never a
   local build's sha1), and `piVersionRange`.

## Code signing

Every release is signed with the CaeloWorks identity of the Certified
PixInsight Developer program (CPD Program Rules, rule 5.1). Without it, users
would have to allow the execution of unsigned scripts to run this one.

Signing happens **after** the build, on the zip, never in CI (no PixInsight, no
keys) and never in `build-update-package.sh`. `scripts/sign-package.sh <zip>`
does it and is the contract the grouped signing run relies on: the zip is its
only argument, `update-package.json` sits next to it, `XSSK_PATH` points to the
keys, the password comes on stdin (prompted on a terminal, one line when
piped), and it exits non-zero on any failure, leaving the zip and sidecar
untouched.

- **Sign the entry script as the zip carries it**, not `pjsr/` in the
  repository: the version stamp changes code.
- **One signature, the entry script's**: `SkyIntruders.xsgn` next to
  `SkyIntruders.js` (the file with `#feature-id`). It covers every file the
  entry script `#include`s, recursively. The `lib/` files are not signed.
- **Re-zip, rewrite the sidecar sha1, check, then swap.** The signed zip and
  sidecar are built in a work directory with `scripts/repro-zip.py` (the
  build's layout), checked by `check-package.sh --signed` (shape, one `.xsgn`,
  `developerId="CaeloWorks"`, sidecar sha1) and `verify-signature.sh`
  (PixInsight validates the signature), and only then moved into place.
- **No entitlements declared.** The `pjsr.*`/`pcl.*` entitlements
  `verify-signature.sh` prints are the CaeloWorks identity's.
- **Comments are not covered**: the signed code is canonicalized. A tamper
  test has to change code.
- **A signed zip is not reproducible** (the signature carries a timestamp).
  CI's reproducibility check runs on the unsigned build.
- **The keys stay off this repository**; the password only ever lives in the
  environment of the PixInsight process that signs.
- **The signing machine must allow unsigned scripts**: `sign-package.sh`,
  `verify-signature.sh` and `build-script-doc.sh` drive PixInsight with small
  unsigned PJSR runners; with the option off, PixInsight refuses them
  silently and the scripts stop with an error saying so. The signed hand
  gate, which needs the option off, runs separately.
- On WSL, `scripts/pi-run.sh` hands a Windows PixInsight its paths and
  variables (wslpath, WSLENV) and works under the Windows `%TEMP%`.
