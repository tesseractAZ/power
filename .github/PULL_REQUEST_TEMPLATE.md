## Summary
<!-- 1–2 sentences. What does this change and why? -->

## Changes
<!-- High-level bullet list. Skip if "Summary" already covers it. -->
-

## Verification
- [ ] `server/` type-checks: `cd server && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
- [ ] `web/` type-checks: `cd web && ./node_modules/.bin/tsc --noEmit -p tsconfig.json`
- [ ] CI green (typecheck matrix + Docker smoke build)
- [ ] Tested against live EcoFlow data, or N/A (docs / CI-only change)
- [ ] If UI changed: screenshot or short clip attached below
- [ ] If `config.yaml` options/ports/schema changed: `DOCS.md` updated to match
- [ ] If add-on packaging changed (`Dockerfile`, `build.yaml`, `rootfs/`): the Docker smoke build covers it, but a fresh install on the Pi is worth a manual check before tagging a release

## Release notes
<!-- Optional. If this should appear in the next CHANGELOG entry, write the
     user-facing line here. Leave empty to let the release workflow use the
     commit subject. -->

## Screenshots / notes
<!-- Optional. -->
