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
- [ ] If `config.yaml` options/schema changed: `python3 scripts/validate-addon-config.py` — **every schema key needs `en` AND `es`** entries; a new key is schema-only and optional (schema ending `?`, no `options:` default), exported by the run script only under `bashio::config.has_value`, with a row in the `OPTIONS` table of `server/src/config.ts` and in `docs/guide/options.md` (the server tests and `check-docs.mjs` hold all three), and in `server/.env.example`, which lists every option
- [ ] `node scripts/check-mutant-anchors.mjs` — all mutation-harness anchors still resolve
- [ ] `node scripts/check-docs.mjs --check` — documentation sizes, links and completeness (D1–D11); the operator guide `ecoflow_panel/DOCS.md` stays at or under 32 KiB (Home Assistant renders all of it on every open of the Documentation tab)
- [ ] `node scripts/check-npm-audit.mjs` — no high/critical advisories in the production dependency tree, no expired waivers
- [ ] If this adds or removes tests, harnesses or workflows, changes the length of the engineering reference in `docs/reference/` by more than 3%, or adds or removes a reference file: the README sentence is updated and `node scripts/check-doc-claims.mjs --tests <N>` passes
- [ ] CI green: type-check matrix · server-test type-check · server tests + README claims · mutant anchors · no personal data · dependency advisories · add-on config · release-PR version (`release-pr.yml`) · Docker smoke build · docs build · CodeQL
- [ ] Tested against live EcoFlow data, or N/A (docs / CI-only change)
- [ ] If UI changed: screenshot or short clip attached below

### If this changes engine behaviour
- [ ] A **committed mutation harness** covers it (`scripts/mutate-*.mjs`), and it kills every mutant. Reverting the fix must make a test fail — "the tests would catch it" is not a claim this repo accepts without the harness.
- [ ] An exemplar reproducing the **motivating defect verbatim** is in the harness, not just the general case.
- [ ] If a mutant survived and you could not kill it, say so here and say why — a known survivor documented in the harness beats a silent gap.
- [ ] The operator guide updated in the same PR, in the present tense, if this adds or changes an option, alarm, entity, device write or setup step: `ecoflow_panel/DOCS.md`, `docs/guide/options.md`, `docs/guide/entities.md`.
- [ ] The owning chapter in `docs/reference/` updated in the same PR, in the present tense, if this adds or changes an engine or API surface. What changed and why goes in `CHANGELOG.md` and this PR, not in the reference.
- [ ] If this adds, removes, renames or moves an engine: its row in the engine index (`docs/reference/A-feature-inventory.md`, A.13) and the index's count sentence are updated, and `node scripts/check-doc-claims.mjs --tests <N>` passes (each row's file must declare its identifier in code; the README's group counts must equal the rows, its floor must sit below the strict reading, and every swept surface must state the same floor). If the floor changes, the repository's About description on GitHub, which no check reads, is changed by hand.
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
