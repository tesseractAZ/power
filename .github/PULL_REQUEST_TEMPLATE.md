## Summary
<!-- 1–2 sentences. What does this change and why? -->

## Changes
<!-- High-level bullet list. Skip if "Summary" already covers it. -->
-

## Verification

CI runs all of the following; the boxes are for what you checked *before* pushing.

- [ ] `cd server && npm test` — the full suite (2,300+ tests)
- [ ] `server/` type-checks, **both projects**: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` and `-p tsconfig.test.json`
- [ ] `web/` type-checks: `cd web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
- [ ] `python3 scripts/check-no-secrets.py` — no home IPs, DIDs, VoIP credentials or personal email in tracked files
- [ ] If `config.yaml` options/schema changed: `python3 scripts/validate-addon-config.py` — **every option needs `en` AND `es`** entries and a `config.yaml` default
- [ ] `node scripts/check-mutant-anchors.mjs` — all mutation-harness anchors still resolve
- [ ] `node scripts/check-npm-audit.mjs` — no high/critical advisories in the production dependency tree, no expired waivers
- [ ] CI green: typecheck matrix · server tests · mutant anchors · no-secrets · add-on config · Docker smoke build · docs build · CodeQL
- [ ] Tested against live EcoFlow data, or N/A (docs / CI-only change)
- [ ] If UI changed: screenshot or short clip attached below

### If this changes engine behaviour
- [ ] A **committed mutation harness** covers it (`scripts/mutate-*.mjs`), and it kills every mutant. Reverting the fix must make a test fail — "the tests would catch it" is not a claim this repo accepts without the harness.
- [ ] An exemplar reproducing the **motivating defect verbatim** is in the harness, not just the general case.
- [ ] If a mutant survived and you could not kill it, say so here and say why — a known survivor documented in the harness beats a silent gap.
- [ ] `DOCS.md` updated in the same PR if this adds or changes an engine, option or API surface.

### If this is a release PR
- [ ] `ecoflow_panel/config.yaml` **version bumped** to exactly the version in the PR title
- [ ] `ecoflow_panel/CHANGELOG.md` has a `## vX.Y.Z` section, **prepended without truncating the file** — check the entry count did not drop
- [ ] Squash subject starts with `Release vX.Y.Z` — `tag-release.yml` is paths-filtered on `config.yaml`, so a missing bump means **no tag, no image, no release, and every check still green**
- [ ] Merge is **gated on the CI conclusion**, not merely on CI finishing

## Release notes
<!-- Optional. If this should appear in the next CHANGELOG entry, write the
     user-facing line here. Leave empty to let the release workflow use the
     commit subject. -->

## Screenshots / notes
<!-- Optional. -->
