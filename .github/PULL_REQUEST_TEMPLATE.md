## Summary
<!-- 1–2 sentences. What does this change and why? -->

## Changes
<!-- High-level bullet list. Skip if "Summary" already covers it. -->
-

## Verification

CI runs all of the following; the boxes are for what you checked *before* pushing.

- [ ] `cd server && npm test` — the full suite, 0 failures (CI checks the README's test count against the run)
- [ ] `server/` type-checks, **both projects**: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` and `-p tsconfig.test.json`
- [ ] `web/` type-checks: `cd web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
- [ ] `python3 scripts/check-no-secrets.py` — no home IPs, DIDs, VoIP credentials, personal email or device serials in tracked files
- [ ] If `config.yaml` options/schema changed: `python3 scripts/validate-addon-config.py` — **every option needs `en` AND `es`** entries and a `config.yaml` default
- [ ] `node scripts/check-mutant-anchors.mjs` — all mutation-harness anchors still resolve
- [ ] `node scripts/check-npm-audit.mjs` — no high/critical advisories in the production dependency tree, no expired waivers
- [ ] If this adds or removes tests, harnesses or workflows, or changes DOCS.md length by more than 3%: the README sentence is updated and `node scripts/check-doc-claims.mjs --tests <N>` passes
- [ ] CI green: type-check matrix · server-test type-check · server tests + README claims · mutant anchors · no personal data · dependency advisories · add-on config · release-PR version (`release-pr.yml`) · Docker smoke build · docs build · CodeQL
- [ ] Tested against live EcoFlow data, or N/A (docs / CI-only change)
- [ ] If UI changed: screenshot or short clip attached below

### If this changes engine behaviour
- [ ] A **committed mutation harness** covers it (`scripts/mutate-*.mjs`), and it kills every mutant. Reverting the fix must make a test fail — "the tests would catch it" is not a claim this repo accepts without the harness.
- [ ] An exemplar reproducing the **motivating defect verbatim** is in the harness, not just the general case.
- [ ] If a mutant survived and you could not kill it, say so here and say why — a known survivor documented in the harness beats a silent gap.
- [ ] `DOCS.md` updated in the same PR if this adds or changes an engine, option or API surface.
- [ ] The harness runs on `scripts/lib/mutateParallel.mjs` and its baseline passes in every worker. A baseline ABORT is not a result: lower `MUTATE_CONCURRENCY` or fix the flaky case.
- [ ] If this moves an existing guard, the harnesses that pin it were re-run — a moved guard can leave its mutant equivalent (2026-10-10: `mutate-analytics-worker` xi after v1.187.10).

### If this touches the security surface
- [ ] A new POST/PUT/DELETE route has `requireWriteAuth` (and a rate limit if it does work on demand); `server/test/writeRoutesGated.test.ts` fails the build otherwise.
- [ ] `ecoflow_panel/apparmor.txt` changes compile fresh (`apparmor_parser -T -Q -K`) and `server/test/apparmorProfile.test.ts` passes; no rule combines `a` with `w`; the blanket `file,` stays.
- [ ] New workflow steps pin actions to a full commit SHA with a version comment.

### If this is a release PR
- [ ] `ecoflow_panel/config.yaml` **version bumped** to exactly the version in the PR title
- [ ] `ecoflow_panel/CHANGELOG.md` has a bare `## X.Y.Z` section (no `v`, no date — Home Assistant's update dialog shows only the new notes when the heading is exactly the version), **prepended without truncating the file**, then `node scripts/roll-changelog.mjs` — check that `CHANGELOG.md` and `CHANGELOG-ARCHIVE.md` together lost no entry (the roll moves older releases to the archive, so the live count drops on purpose)
- [ ] Title (and, for a one-commit PR, the commit's subject, which its squash merge lands with) is `Release vX.Y.Z …`, the version above every `vX.Y.Z` tag — Home Assistant offers whatever `config.yaml` declares on `main` (a lower version too), and `tag-release.yml` tags it on the merge or fails the run
- [ ] Merge is **gated on the CI conclusion**, not merely on CI finishing

## Release notes
<!-- Optional. If this should appear in the next CHANGELOG entry, write the
     user-facing line here. Leave empty to let the release workflow use the
     commit subject. -->

## Screenshots / notes
<!-- Optional. -->
