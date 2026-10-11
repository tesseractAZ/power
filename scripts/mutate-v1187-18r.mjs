#!/usr/bin/env node
/**
 * mutate-v1187-18r.mjs — the release pipeline: tag-release.yml as a reconciler, the release-PR check
 * on the test merge, pinned runners, native builds without QEMU, strict versions end to end.
 *
 *   T-i      a run whose push main has moved past is not treated as superseded
 *   T-ii     a revert to a released version (or a reused number) passes quietly
 *   T-iii    the step trusts checkout's origin/main (no re-fetch of main and the tags)
 *   T-iv     a "Release vX" merge that did not change the version is green
 *   T-v      every first attempt re-dispatches images.yml when the Release is not out yet
 *   T-vi     a loose version pattern (leading zeros pass)
 *   T-vii    a tag at a later main commit is an error
 *   T-viii   a tag on a branch built on this commit counts as on main
 *   T-ix     a pre-release tag raises the floor (no strict filter on the tags)
 *   T-x      a version that reached main untagged is tagged at the tip, not where it arrived
 *   T-xi     an untagged version at or below the highest tag is tagged
 *   T-xii    a subject naming another version than config.yaml is green
 *   T-xiii   images.yml is dispatched before the tag push
 *   T-xiv    a commit that is not on main can be tagged
 *   T-xv     a config.yaml that declares version twice is accepted
 *   T-xvi    a CRLF subject keeps its carriage return
 *   S-i      the paths filter returns
 *   S-ii     the subject gate returns
 *   S-iii    the commit message is interpolated into the script
 *   S-iv     a newer push cancels the running reconcile
 *   R-i      a title edit no longer re-runs the release-PR check
 *   R-ii     the release-PR check checks out one commit
 *   R-iii    the required check is renamed
 *   I-i      QEMU returns to the native builds
 *   I-ii     the arm64 build moves to an x64 runner
 *   I-iii    a job runs on the moving ubuntu-latest label
 *   I-iv     the highest tag is chosen as a string
 *   I-v      a non-strict tag counts as the highest
 *   I-vi     resolve accepts a loose version
 *   I-vii    a re-dispatch cancels the running build of the same version
 *   E-i      release.yml bumps from config.yaml alone, ignoring a higher tag
 *   E-ii     release.yml opens its PR without the release-PR check
 *   P-i      the PR check compares the PR head, not the test merge
 *   P-ii     a "Release vX" title that changes no version passes
 *   P-iii    a reused tag passes
 *   P-iv     the merge-commit guard is gone
 *   P-v      the CHANGELOG heading accepts what images.yml rejects
 *   P-vi     a downgrade passes
 *   P-vii    a version below the highest tag passes
 *   P-viii   a loose version pattern
 *   P-ix     a version change under the wrong title passes
 *   P-x      a doubled version line passes
 *   P-xi     no visible tags passes
 *
 * Every kill comes from the subset (fullSuite: false): the tag step and check-release-pr.py are RUN
 * there, in temporary repositories. Anchors sit on script and step lines, never on a pinned
 * `uses:` line, so an action bump cannot strand them.
 *
 *   node scripts/mutate-v1187-18r.mjs
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAGREL = resolve(REPO, '.github/workflows/tag-release.yml');
const PRWF = resolve(REPO, '.github/workflows/release-pr.yml');
const IMG = resolve(REPO, '.github/workflows/images.yml');
const RELWF = resolve(REPO, '.github/workflows/release.yml');
const PRCHECK = resolve(REPO, 'scripts/check-release-pr.py');
const SUBSET = [
  'test/tagRelease.test.ts',
  'test/tagReleaseEdges.test.ts',
  'test/releasePrCheck.test.ts',
  'test/workflowRunners.test.ts',
  'test/workflowNativeBuild.test.ts',
  'test/workflowTimeouts.test.ts',
];

const MUTANTS = [
  {
    id: "T-i. ★★★ a run whose push main has moved past is not treated as superseded",
    file: TAGREL,
    find: "            if [[ \"$TIPV\" != \"$V\" ]]; then",
    to: "            if false; then # MUTANT",
    why: "An older release's run executing after a newer one reports a false \"not above the highest tag\" error.",
  },
  {
    id: "T-ii. ★★★ a revert to a released version (or a reused number) passes quietly",
    file: TAGREL,
    find: "              if [[ -n \"$BV\" && \"$BV\" != \"$V\" ]]; then\n                echo \"::error::This push moved config.yaml",
    to: "              if false; then # MUTANT\n                echo \"::error::This push moved config.yaml",
    why: "HA offers the downgrade (auto-update installs it) while the run is green.",
  },
  {
    id: "T-iii. ★★★ the step trusts checkout's origin/main (no re-fetch of main and the tags)",
    file: TAGREL,
    find: "          git fetch --quiet --force origin '+refs/heads/main:refs/remotes/origin/main' '+refs/tags/*:refs/tags/*'",
    to: "          : # MUTANT no re-fetch",
    why: "checkout forces origin/main to the run's commit, so a run that executes late cannot see main moved on.",
  },
  {
    id: "T-iv. ★★★ a \"Release vX\" merge that did not change the version is green",
    file: TAGREL,
    find: "          if [[ -n \"$SUBJ_V\" && -n \"$BV\" && \"$BV\" == \"$V\" ]]; then",
    to: "          if false; then # MUTANT",
    why: "v1.130.0 again: the release silently does not happen.",
  },
  {
    id: "T-v. ★★ every first attempt re-dispatches images.yml when the Release is not out yet",
    file: TAGREL,
    find: "            elif [[ \"${GITHUB_RUN_ATTEMPT:-1}\" != \"1\" || \"${EVENT_NAME:-}\" == \"workflow_dispatch\" ]]; then",
    to: "            elif true; then # MUTANT",
    why: "Every push after a release re-dispatches a build that is still running (a second build, a moved :latest).",
  },
  {
    id: "T-vi. ★★★ a loose version pattern (leading zeros pass)",
    file: TAGREL,
    find: "          CFG=ecoflow_panel/config.yaml\n          SEMVER='^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
    to: "          CFG=ecoflow_panel/config.yaml\n          SEMVER='^[0-9]+\\.[0-9]+\\.[0-9]+$' # MUTANT",
    why: "A version like 1.0.01 is tagged; arithmetic reads it as octal, and HA compares it as a string.",
  },
  {
    id: "T-vii. ★★ a tag at a later main commit is an error",
    file: TAGREL,
    find: "            if [[ \"$TAGC\" == \"$SHA\" ]] || { git merge-base --is-ancestor \"$SHA\" \"$TAGC\" && git merge-base --is-ancestor \"$TAGC\" \"$TIP\"; }; then",
    to: "            if [[ \"$TAGC\" == \"$SHA\" ]]; then # MUTANT",
    why: "A run executing after its version was tagged further along main fails falsely.",
  },
  {
    id: "T-viii. ★★ a tag on a branch built on this commit counts as on main",
    file: TAGREL,
    find: "            if [[ \"$TAGC\" == \"$SHA\" ]] || { git merge-base --is-ancestor \"$SHA\" \"$TAGC\" && git merge-base --is-ancestor \"$TAGC\" \"$TIP\"; }; then",
    to: "            if [[ \"$TAGC\" == \"$SHA\" ]] || git merge-base --is-ancestor \"$SHA\" \"$TAGC\"; then # MUTANT",
    why: "The Release would be built from a commit main never had.",
  },
  {
    id: "T-ix. ★★ a pre-release tag raises the floor (no strict filter on the tags)",
    file: TAGREL,
    find: "            [[ \"$x\" =~ $SEMVER ]] || continue\n            if [[ -z \"$HIGH\" ]] || gt \"$x\" \"$HIGH\"; then HIGH=$x; fi",
    to: "            if [[ -z \"$HIGH\" ]] || gt \"$x\" \"$HIGH\"; then HIGH=$x; fi # MUTANT",
    why: "A stray v1.1.0-rc1 breaks the comparison and blocks the release.",
  },
  {
    id: "T-x. ★★★ a version that reached main untagged is tagged at the tip, not where it arrived",
    file: TAGREL,
    find: "            while p=$(git rev-parse -q --verify \"${TARGET}^1\") && [[ \"$(ver_at \"$p\")\" == \"$V\" ]]; do TARGET=$p; done",
    to: "            : # MUTANT no first-parent walk",
    why: "The self-healed tag (and its image) carries commits that were not in the release.",
  },
  {
    id: "T-xi. ★★★ an untagged version at or below the highest tag is tagged",
    file: TAGREL,
    find: "          if [[ -n \"$HIGH\" ]] && ! gt \"$V\" \"$HIGH\"; then",
    to: "          if false; then # MUTANT",
    why: "A lowered, never-released version is published and marked as a release.",
  },
  {
    id: "T-xii. ★★ a subject naming another version than config.yaml is green",
    file: TAGREL,
    find: "          if [[ -n \"$SUBJ_V\" && \"$SUBJ_V\" != \"$V\" ]]; then\n            echo \"::error::The subject says",
    to: "          if false; then # MUTANT\n            echo \"::error::The subject says",
    why: "The squash subject and the tag disagree and nothing turns red.",
  },
  {
    id: "T-xiii. ★★★ images.yml is dispatched before the tag push",
    file: TAGREL,
    find: "          git push origin \"refs/tags/${TAG}\"\n          echo \"Tagged ${TAG} at ${TARGET:0:9}.\"\n          # The tag push (GITHUB_TOKEN) does not start images.yml, so dispatch it; it checks out the tag.\n          gh workflow run images.yml -f version=\"$V\"",
    to: "          gh workflow run images.yml -f version=\"$V\" # MUTANT dispatch first\n          git push origin \"refs/tags/${TAG}\"\n          echo \"Tagged ${TAG} at ${TARGET:0:9}.\"",
    why: "A rejected tag push still starts a build for a tag that does not exist.",
  },
  {
    id: "T-xiv. ★★ a commit that is not on main can be tagged",
    file: TAGREL,
    find: "          if ! git merge-base --is-ancestor \"$SHA\" \"$TIP\"; then",
    to: "          if false; then # MUTANT",
    why: "A manual dispatch from another branch is reconciled as if it were main.",
  },
  {
    id: "T-xv. ★★ a config.yaml that declares version twice is accepted",
    file: TAGREL,
    find: "          if [[ \"$NV\" != 1 ]]; then",
    to: "          if false; then # MUTANT",
    why: "The step tags the first version line; HA (a YAML loader) offers the last.",
  },
  {
    id: "T-xvi. ★ a CRLF subject keeps its carriage return",
    file: TAGREL,
    find: "SUBJ=${SUBJ%%$'\\n'*}; SUBJ=${SUBJ%%$'\\r'*}",
    to: "SUBJ=${SUBJ%%$'\\n'*} # MUTANT",
    why: "The annotation and the subject parse carry a stray \\r.",
  },
  {
    id: "S-i. ★★★ the paths filter returns",
    file: TAGREL,
    find: "on:\n  push:\n    branches: [main]\n  workflow_dispatch:",
    to: "on:\n  push:\n    branches: [main]\n    paths:\n      - 'ecoflow_panel/config.yaml'\n  workflow_dispatch:",
    why: "A \"Release vX\" merge that forgot the bump is never evaluated (v1.130.0).",
  },
  {
    id: "S-ii. ★★★ the subject gate returns",
    file: TAGREL,
    find: "    name: Tag + trigger image build\n    runs-on: ubuntu-24.04",
    to: "    name: Tag + trigger image build\n    if: startsWith(github.event.head_commit.message, 'Release v')\n    runs-on: ubuntu-24.04",
    why: "A bump merged under another subject is never tagged (v0.54.1).",
  },
  {
    id: "S-iii. ★★★ the commit message is interpolated into the script",
    file: TAGREL,
    find: "          SUBJ=${HEAD_MSG:-};",
    to: "          SUBJ=\"${{ github.event.head_commit.message }}\";",
    why: "A commit subject becomes shell code in a job holding contents:write.",
  },
  {
    id: "S-iv. ★★ a newer push cancels the running reconcile",
    file: TAGREL,
    find: "  group: tag-release\n  cancel-in-progress: false",
    to: "  group: tag-release\n  cancel-in-progress: true",
    why: "A run can be cancelled between the tag push and the dispatch.",
  },
  {
    id: "R-i. ★★ a title edit no longer re-runs the release-PR check",
    file: PRWF,
    find: "    types: [opened, synchronize, reopened, edited]",
    to: "    types: [opened, synchronize, reopened]",
    why: "Retitling a PR to \"Release vX\" (or away from it) leaves a stale verdict.",
  },
  {
    id: "R-ii. ★★ the release-PR check checks out one commit",
    file: PRWF,
    find: "          fetch-depth: 0\n\n      - name: Version bump + CHANGELOG section present",
    to: "          fetch-depth: 1\n\n      - name: Version bump + CHANGELOG section present",
    why: "No HEAD^1 and no tags: the comparison cannot run.",
  },
  {
    id: "R-iii. ★★ the required check is renamed",
    file: PRWF,
    find: "    name: Release PR declares the version it names",
    to: "    name: Release PR check",
    why: "main requires the check by name; every PR would wait on one that never reports.",
  },
  {
    id: "I-i. ★★ QEMU returns to the native builds",
    file: IMG,
    find: "      - id: buildx\n",
    to: "      - uses: docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0\n      - id: buildx\n",
    why: "A Docker Hub pull on every build job for emulation no build uses.",
  },
  {
    id: "I-ii. ★★ the arm64 build moves to an x64 runner",
    file: IMG,
    find: "            runner: ubuntu-24.04-arm",
    to: "            runner: ubuntu-24.04",
    why: "linux/arm64 on an amd64 host needs emulation (30-60 min builds).",
  },
  {
    id: "I-iii. ★★★ a job runs on the moving ubuntu-latest label",
    file: IMG,
    find: "    name: Resolve version\n    runs-on: ubuntu-24.04",
    to: "    name: Resolve version\n    runs-on: ubuntu-latest",
    why: "ubuntu-latest becomes Ubuntu 26.04 from 2026-10-19, under every job at once.",
  },
  {
    id: "I-iv. ★★ the highest tag is chosen as a string",
    file: IMG,
    find: "          print(max(tags, key=lambda t: tuple(map(int, t[1:].split(\".\")))) if tags else \"\")",
    to: "          print(max(tags) if tags else \"\") # MUTANT",
    why: "v1.2.3 ranks above v1.2.10: an older release is marked Latest.",
  },
  {
    id: "I-v. ★★ a non-strict tag counts as the highest",
    file: IMG,
    find: "(v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*))$\", l.strip()))]",
    to: "(v\\S+)$\", l.strip()))] # MUTANT",
    why: "A stray v1.2.3-rc1 demotes the real release (what sort -V did).",
  },
  {
    id: "I-vi. ★★ resolve accepts a loose version",
    file: IMG,
    find: "          if [[ ! \"$v\" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then",
    to: "          if [[ ! \"$v\" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then # MUTANT",
    why: "A dispatch of 1.0.01 publishes a version tag-release would never tag.",
  },
  {
    id: "I-vii. ★ a re-dispatch cancels the running build of the same version",
    file: IMG,
    find: "  group: images-${{ inputs.version && format('v{0}', inputs.version) || github.ref_name }}\n  cancel-in-progress: false",
    to: "  group: images-${{ inputs.version && format('v{0}', inputs.version) || github.ref_name }}\n  cancel-in-progress: true",
    why: "A build is cancelled mid-push.",
  },
  {
    id: "E-i. ★★ release.yml bumps from config.yaml alone, ignoring a higher tag",
    file: RELWF,
    find: "            if gt \"$x\" \"$floor\"; then floor=$x; fi",
    to: "            : # MUTANT",
    why: "The next version can land below an existing tag; tag-release then refuses it after the merge.",
  },
  {
    id: "E-ii. ★★ release.yml opens its PR without the release-PR check",
    file: RELWF,
    find: "          BASE_REV=origin/main PR_TITLE=\"Release v${NEXT}\" python3 scripts/check-release-pr.py\n",
    to: "          : # MUTANT\n",
    why: "CI never runs on a PR opened with GITHUB_TOKEN, so nothing checks it.",
  },
  {
    id: "P-i. ★★★ the PR check compares the PR head, not the test merge",
    file: PRCHECK,
    find: "    base_rev = os.environ.get(\"BASE_REV\") or \"HEAD^1\"",
    to: "    base_rev = os.environ.get(\"BASE_REV\") or \"HEAD^2\"  # MUTANT",
    why: "A branch cut before the last release reads as a downgrade; a real release reads as no change.",
  },
  {
    id: "P-ii. ★★★ a \"Release vX\" title that changes no version passes",
    file: PRCHECK,
    find: "    if not changed and title_v is None:",
    to: "    if not changed:  # MUTANT",
    why: "v1.130.0 merges green again.",
  },
  {
    id: "P-iii. ★★★ a reused tag passes",
    file: PRCHECK,
    find: "        if new in tags:",
    to: "        if False:  # MUTANT",
    why: "A Release tag cannot be reused; tag-release fails after the merge.",
  },
  {
    id: "P-iv. ★★★ the merge-commit guard is gone",
    file: PRCHECK,
    find: "    if not os.environ.get(\"BASE_REV\") and git(\"rev-parse\", \"-q\", \"--verify\", \"HEAD^2\").returncode:",
    to: "    if False:  # MUTANT",
    why: "A shallow or non-merge checkout compares the wrong commits and passes.",
  },
  {
    id: "P-v. ★★★ the CHANGELOG heading accepts what images.yml rejects",
    file: PRCHECK,
    find: "rf\"^## v?{re.escape(new)}\\b\"",
    to: "rf\"^##\\s+v?{re.escape(new)}\\b\"",
    why: "A \"##  vX\" heading passes the PR and fails the publish after the tag exists.",
  },
  {
    id: "P-vi. ★★★ a downgrade passes",
    file: PRCHECK,
    find: "        if base and SEMVER_RE.match(base) and key(new) <= key(base):",
    to: "        if False:  # MUTANT",
    why: "HA offers the lower version to every install.",
  },
  {
    id: "P-vii. ★★ a version below the highest tag passes",
    file: PRCHECK,
    find: "        if top and key(new) < key(top):",
    to: "        if False:  # MUTANT",
    why: "tag-release refuses it after the merge, when HA already offers it.",
  },
  {
    id: "P-viii. ★★ a loose version pattern",
    file: PRCHECK,
    find: "SEMVER_RE = re.compile(r\"^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$\")",
    to: "SEMVER_RE = re.compile(r\"^\\d+\\.\\d+\\.\\d+\")  # MUTANT",
    why: "A pre-release or leading-zero version passes; tag-release cannot tag it.",
  },
  {
    id: "P-ix. ★★ a version change under the wrong title passes",
    file: PRCHECK,
    find: "        if title_v != new:",
    to: "        if False:  # MUTANT",
    why: "A bump merges under any title.",
  },
  {
    id: "P-x. ★ a doubled version line passes",
    file: PRCHECK,
    find: "        if version_lines(head_cfg) != 1:",
    to: "        if False:  # MUTANT",
    why: "The check reads the first version line; HA keeps the last.",
  },
  {
    id: "P-xi. ★★ no visible tags passes",
    file: PRCHECK,
    find: "        if not tags:",
    to: "        if False:  # MUTANT",
    why: "A checkout without tags skips the reuse and floor checks.",
  },
];

// Mutants run in parallel, each in its own copy of the tree (scripts/lib/mutateParallel.mjs).
import { runMutantsParallel } from './lib/mutateParallel.mjs';
await runMutantsParallel({ name: 'mutate-v1187-18r', mutants: MUTANTS, subset: SUBSET, root: REPO, fullSuite: false });
