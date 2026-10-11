/**
 * tag-release.yml reconciles main's version with the tags (the structure, and the core runs).
 *
 * Home Assistant offers whatever `version:` ecoflow_panel/config.yaml declares on main, and a lower
 * version is offered too (Supervisor's need_update is `version != latest_version`), so every push
 * to main matters. tag-release.yml ran only for a push that touched config.yaml with a subject
 * starting "Release v": a bump merged under another subject (v0.54.1) was never tagged, and a
 * "Release v" merge without the bump (v1.130.0) was never evaluated. It now runs on every push,
 * tags the version main declares or fails loudly when that version cannot be published, and handles
 * runs that execute out of order.
 *
 * The tag step's own script is RUN, with `bash -e`, in temporary repositories against a stub `gh`
 * (helpers/workflowRepo.ts). It must stay bash-3.2-compatible: macOS runs it with /bin/bash.
 * The edge cases are in tagReleaseEdges.test.ts (split for the parallel test runner), the PR check
 * in releasePrCheck.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_YML, TAG_STEP, TAG_SCRIPT, wf, topBlock, world, released100, dispatchOf } from './helpers/workflowRepo.js';

const PR_YML = wf('release-pr.yml');
const IMAGES_YML = wf('images.yml');

/**
 * A checkout step with full history: the pin's SHAPE (40 hex + `# v…`), never its value. Dependabot
 * moves the pin in every workflow at once (workflowActionPins.test.ts holds one pin per action), and
 * a literal SHA here would turn the required 'Server tests' red on that bump (#518).
 */
const FULL_CHECKOUT = /^ {6}- uses: actions\/checkout@[0-9a-f]{40} # v\S+\n {8}with:\n {10}fetch-depth: 0$/m;

/* ── structure ─────────────────────────────────────────────────────────────── */

test('★★★ tag-release runs on EVERY push to main (no paths filter, no subject gate) and on a manual dispatch', () => {
  const on = topBlock(TAG_YML, 'on');
  assert.match(on, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.doesNotMatch(on, /paths/, 'a paths filter hides a "Release vX" merge that forgot the bump');
  assert.doesNotMatch(on, /tags:/);
  assert.match(on, /^ {2}workflow_dispatch:\s*$/m);
  const job = TAG_YML.slice(TAG_YML.indexOf('\n  tag:\n'));
  assert.doesNotMatch(job, /^ {4}if:/m, 'no job-level gate: the step reconciles every push');
  assert.match(job, /^ {4}runs-on: ubuntu-\d{2}\.\d{2}$/m);
  const t = /^ {4}timeout-minutes: (\d+)$/m.exec(job);
  assert.ok(t && Number(t[1]) > 0 && Number(t[1]) <= 30, 'the job is bounded');
});

test('★★★ runs are serialized and none is cancelled: concurrency group, no cancel-in-progress, a queue', () => {
  const c = topBlock(TAG_YML, 'concurrency');
  assert.match(c, /^ {2}group: tag-release$/m);
  assert.match(c, /^ {2}cancel-in-progress: false$/m);
  assert.match(c, /^ {2}queue: max$/m);
});

test('★★ the checkout fetches all history and tags, and the permissions are exactly tag + dispatch', () => {
  assert.match(TAG_YML, FULL_CHECKOUT);
  const p = topBlock(TAG_YML, 'permissions').split('\n').slice(1).map((l) => l.replace(/\s+#.*$/, '').trim()).filter(Boolean);
  assert.deepEqual(p.sort(), ['actions: write', 'contents: write']);
});

test('★★★ event data reaches the script only through env, never as an expression inside it', () => {
  assert.match(TAG_STEP, /^ {10}BEFORE: \$\{\{ github\.event\.before \}\}$/m);
  assert.match(TAG_STEP, /^ {10}HEAD_MSG: \$\{\{ github\.event\.head_commit\.message \}\}$/m);
  assert.match(TAG_STEP, /^ {10}EVENT_NAME: \$\{\{ github\.event_name \}\}$/m);
  assert.match(TAG_STEP, /^ {10}GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m);
  assert.ok(!TAG_SCRIPT.includes('${{'), 'a commit message interpolated into the script is code');
  assert.match(TAG_SCRIPT, /^set -euo pipefail$/m);
});

test('★★ release-pr.yml: its own workflow, re-run on a title edit, same required check name, full history', () => {
  const on = topBlock(PR_YML, 'on');
  assert.match(on, /^ {2}pull_request:$/m);
  assert.match(on, /^ {4}branches: \[main\]$/m);
  const types = /^ {4}types: \[(.*)\]$/m.exec(on);
  assert.ok(types, 'no types list');
  assert.deepEqual(types[1].split(',').map((s) => s.trim()).sort(), ['edited', 'opened', 'reopened', 'synchronize']);
  assert.match(PR_YML, /^ {4}name: Release PR declares the version it names$/m);
  assert.match(PR_YML, FULL_CHECKOUT);
  assert.match(PR_YML, /^ {10}PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}$/m);
  assert.match(PR_YML, /^ {8}run: python3 scripts\/check-release-pr\.py$/m);
  assert.deepEqual(topBlock(PR_YML, 'permissions').split('\n').slice(1).map((l) => l.trim()).filter(Boolean), ['contents: read']);
  // One job with the required check's name across every workflow (it left ci.yml).
  const all = ['ci.yml', 'codeql.yml', 'images.yml', 'release.yml', 'release-pr.yml', 'tag-release.yml']
    .flatMap((f) => wf(f).split('\n').filter((l) => /^ {4}name: Release PR declares the version it names$/.test(l)));
  assert.equal(all.length, 1);
});

test('★★ images.yml: a run name, one run per version at a time (none cancelled)', () => {
  assert.match(IMAGES_YML, /^run-name: .*inputs\.version.*github\.ref_name/m);
  const c = topBlock(IMAGES_YML, 'concurrency');
  assert.match(c, /^ {2}group: images-\$\{\{ inputs\.version && format\('v\{0\}', inputs\.version\) \|\| github\.ref_name \}\}$/m);
  assert.match(c, /^ {2}cancel-in-progress: false$/m);
});

test('★★★ a release merge is tagged at its commit and images.yml is dispatched exactly once', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.1 — fixes (#2)');
  const before = w.push();
  const r = w.run({ sha: c2, before, msg: 'Release v1.0.1 — fixes (#2)\n\nbody', releases: ['v1.0.0'] });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.1'], c2);
  assert.deepEqual(r.dispatched, [dispatchOf('1.0.1')]);
  // An annotated tag, made by the bot: the runner has no git identity of its own (nor does this step's config).
  assert.deepEqual(w.tagInfo('v1.0.1'), { type: 'tag', tagger: 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>' });
  // A re-run after success (tag at this commit, Release out) does nothing.
  const again = w.run({ sha: c2, before, msg: 'Release v1.0.1 — fixes (#2)', attempt: '2', releases: ['v1.0.0', 'v1.0.1'] });
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(again.dispatched, []);
  assert.match(again.out, /::notice::v1\.0\.1 is tagged and released/);
  assert.equal(w.tags()['v1.0.1'], c2);
}));

test('★★★ an ordinary push (version unchanged, tagged, released) is a no-op: no tag, no dispatch', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.0', 'deps: bump something (#3)');
  const before = w.push();
  const r = w.run({ sha: c2, before, msg: 'deps: bump something (#3)', releases: ['v1.0.0'] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.dispatched, []);
  assert.deepEqual(Object.keys(w.tags()), ['v1.0.0']);
  assert.doesNotMatch(r.out, /::(error|warning)::/);
}));

test('★★★ a bump merged under another subject (v0.54.1) is tagged, with a warning', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'bump version (#4)');
  const before = w.push();
  const r = w.run({ sha: c2, before, msg: 'bump version (#4)', releases: ['v1.0.0'] });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.1'], c2);
  assert.deepEqual(r.dispatched, [dispatchOf('1.0.1')]);
  assert.match(r.out, /::warning::1\.0\.0 -> 1\.0\.1 landed under the subject 'bump version \(#4\)'/);
}));

test('★★★ a "Release vX" merge that did not change the version (v1.130.0) is a red run', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.0', 'Release v1.0.1 — forgot the bump (#5)');
  const before = w.push();
  const r = w.run({ sha: c2, before, msg: 'Release v1.0.1 — forgot the bump (#5)', releases: ['v1.0.0'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::'Release v1\.0\.1 — forgot the bump \(#5\)' landed, but config\.yaml's version did not change/);
  assert.deepEqual(r.dispatched, []);
  // A raced duplicate "Release v1.0.1" after the real one was tagged: red, and the tag stays.
  const c3 = w.commit('1.0.1', 'Release v1.0.1 — real');
  const b3 = w.push();
  assert.equal(w.run({ sha: c3, before: b3, msg: 'Release v1.0.1 — real', releases: ['v1.0.0'] }).status, 0);
  const c4 = w.commit('1.0.1', 'Release v1.0.1 — duplicate (#6)');
  const b4 = w.push();
  const dup = w.run({ sha: c4, before: b4, msg: 'Release v1.0.1 — duplicate (#6)', releases: ['v1.0.0', 'v1.0.1'] });
  assert.equal(dup.status, 1, dup.out);
  assert.equal(w.tags()['v1.0.1'], c3);
  assert.deepEqual(dup.dispatched, []);
}));

test('★★ a "Release vX" merge with no bump stays red even when its run executes after main moved on', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.0', 'Release v1.0.1 — forgot the bump (#8)');
  const b2 = w.push();
  w.commit('1.0.2', 'Release v1.0.2 — the real bump (#9)');
  w.push();
  // c2's queued run executes only now: superseded, but the no-bump merge is still reported red.
  const r = w.run({ sha: c2, before: b2, msg: 'Release v1.0.1 — forgot the bump (#8)', releases: ['v1.0.0'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::'Release v1\.0\.1 — forgot the bump \(#8\)' landed, but config\.yaml's version did not change/);
  assert.match(r.out, /::notice::main moved on to 1\.0\.2/);
  assert.deepEqual(r.dispatched, []);
  assert.deepEqual(Object.keys(w.tags()), ['v1.0.0']);
}));

test('★★ a subject naming another version than config.yaml: tags config.yaml\'s version (what HA offers), red run', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.2 — typo');
  const before = w.push();
  const r = w.run({ sha: c2, before, msg: 'Release v1.0.2 — typo', releases: ['v1.0.0'] });
  assert.equal(r.status, 1, r.out);
  assert.equal(w.tags()['v1.0.1'], c2);
  assert.equal(w.tags()['v1.0.2'], undefined);
  assert.deepEqual(r.dispatched, [dispatchOf('1.0.1')]);
  assert.match(r.out, /::error::The subject says Release v1\.0\.2; config\.yaml says 1\.0\.1/);
}));

test('★★ a subject naming another version is red even when a later push\'s run tagged that commit first', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.2 — typo');
  const b2 = w.push();
  const c3 = w.commit('1.0.1', 'deps: bump x (#8)');
  const b3 = w.push();
  // The later push's run executes first and tags c2, where 1.0.1 reached main.
  const later = w.run({ sha: c3, before: b3, msg: 'deps: bump x (#8)', releases: ['v1.0.0'] });
  assert.equal(later.status, 0, later.out);
  assert.equal(w.tags()['v1.0.1'], c2);
  // c2's own run finds the tag already there, and still reports the mismatched subject.
  const first = w.run({ sha: c2, before: b2, msg: 'Release v1.0.2 — typo', releases: ['v1.0.0'] });
  assert.equal(first.status, 1, first.out);
  assert.match(first.out, /::error::The subject says Release v1\.0\.2; config\.yaml says 1\.0\.1/);
  assert.deepEqual(first.dispatched, []);
}));

test('★★★ a revert to a released version is red on EVERY push and dispatch while main sits below the newest release', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.1');
  const b2 = w.push();
  assert.equal(w.run({ sha: c2, before: b2, msg: 'Release v1.0.1', releases: ['v1.0.0'] }).status, 0);
  const released = ['v1.0.0', 'v1.0.1'];
  const c3 = w.commit('1.0.0', 'Revert "Release v1.0.1"');
  const b3 = w.push();
  const r = w.run({ sha: c3, before: b3, msg: 'Revert "Release v1.0.1"', releases: released });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::main declares 1\.0\.0 \(released from [0-9a-f]{9}\), but v1\.0\.1 is out/);
  assert.deepEqual(r.dispatched, []);
  // The state, not the push: the next ordinary push and a manual dispatch are red too (HA still offers 1.0.0).
  const c4 = w.commit('1.0.0', 'deps: bump x (#10)');
  const b4 = w.push();
  const later = w.run({ sha: c4, before: b4, msg: 'deps: bump x (#10)', releases: released });
  assert.equal(later.status, 1, later.out);
  assert.match(later.out, /but v1\.0\.1 is out/);
  const dispatched = w.run({ sha: c4, event: 'workflow_dispatch', msg: '', releases: released });
  assert.equal(dispatched.status, 1, dispatched.out);
  assert.deepEqual([...later.dispatched, ...dispatched.dispatched], []);
  // Re-landing the released number after the revert: red, and the immutable tag does not move.
  const c5 = w.commit('1.0.1', 'Release v1.0.1 — again');
  const b5 = w.push();
  const again = w.run({ sha: c5, before: b5, msg: 'Release v1.0.1 — again', releases: released });
  assert.equal(again.status, 1, again.out);
  assert.match(again.out, /::error::This push moved config\.yaml from 1\.0\.0 \(released\) to 1\.0\.1/);
  assert.equal(w.tags()['v1.0.1'], c2);
  assert.deepEqual(again.dispatched, []);
}));

test('★★ restoring the released version after one that was never published is green, not a false "bump above"', () => {
  world((w) => {
    // A pre-release spelling lands (red: it cannot be tagged), then the fix restores 1.0.0.
    released100(w);
    const bad = w.commit({ raw: 'name: Power\nversion: "1.0.1-beta"\n' }, 'try a beta');
    const b2 = w.push();
    assert.equal(w.run({ sha: bad, before: b2, msg: 'try a beta', releases: ['v1.0.0'] }).status, 1);
    const fix = w.commit('1.0.0', 'Revert "try a beta"');
    const b3 = w.push();
    const r = w.run({ sha: fix, before: b3, msg: 'Revert "try a beta"', releases: ['v1.0.0'] });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /::notice::v1\.0\.0 is tagged and released/);
  });
  world((w) => {
    // A release merge is reverted before its queued run starts: that run is superseded and tags nothing,
    // so 1.0.1 never existed and the revert's run is green.
    released100(w);
    const c2 = w.commit('1.0.1', 'Release v1.0.1');
    const b2 = w.push();
    const c3 = w.commit('1.0.0', 'Revert "Release v1.0.1"');
    const b3 = w.push();
    const first = w.run({ sha: c2, before: b2, msg: 'Release v1.0.1', releases: ['v1.0.0'] });
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /::notice::main moved on to 1\.0\.0/);
    const r = w.run({ sha: c3, before: b3, msg: 'Revert "Release v1.0.1"', releases: ['v1.0.0'] });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(Object.keys(w.tags()), ['v1.0.0']);
  });
});

test('★★★ an untagged version that is not above the highest tag is a red run and is never tagged', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.5', 'Release v1.0.5');
  const b2 = w.push();
  assert.equal(w.run({ sha: c2, before: b2, msg: 'Release v1.0.5', releases: ['v1.0.0'] }).status, 0);
  const c3 = w.commit('1.0.3', 'lower it');
  const b3 = w.push();
  const r = w.run({ sha: c3, before: b3, msg: 'lower it', releases: ['v1.0.0', 'v1.0.5'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /::error::main declares 1\.0\.3, never released and not above v1\.0\.5/);
  assert.equal(w.tags()['v1.0.3'], undefined);
  assert.deepEqual(r.dispatched, []);
}));

test('★★★ runs out of order: the older release\'s run is superseded (exit 0, no false error, no tag)', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.1');
  const b2 = w.push();
  const c3 = w.commit('1.0.2', 'Release v1.0.2');
  const b3 = w.push();
  const newer = w.run({ sha: c3, before: b3, msg: 'Release v1.0.2', releases: ['v1.0.0'] });
  assert.equal(newer.status, 0, newer.out);
  assert.equal(w.tags()['v1.0.2'], c3);
  const older = w.run({ sha: c2, before: b2, msg: 'Release v1.0.1', releases: ['v1.0.0'] });
  assert.equal(older.status, 0, older.out);
  assert.match(older.out, /::notice::main moved on to 1\.0\.2/);
  assert.equal(w.tags()['v1.0.1'], undefined);
  assert.deepEqual(older.dispatched, []);
}));

test('★★★ a release push then an ordinary push, run out of order: the later run tags the commit that brought the version', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.1');
  const b2 = w.push();
  const c3 = w.commit('1.0.1', 'docs: typo (#7)');
  const b3 = w.push();
  const later = w.run({ sha: c3, before: b3, msg: 'docs: typo (#7)', releases: ['v1.0.0'] });
  assert.equal(later.status, 0, later.out);
  assert.equal(w.tags()['v1.0.1'], c2, 'tagged where 1.0.1 reached main, not the tip');
  assert.deepEqual(later.dispatched, [dispatchOf('1.0.1')]);
  assert.match(later.out, /::warning::v1\.0\.1 was not tagged when 1\.0\.1 reached main/);
  // The release push's own run then finds its tag; images.yml is still running, so it only warns.
  const first = w.run({ sha: c2, before: b2, msg: 'Release v1.0.1', releases: ['v1.0.0'] });
  assert.equal(first.status, 0, first.out);
  assert.deepEqual(first.dispatched, []);
  assert.match(first.out, /::warning::v1\.0\.1 exists but has no Release yet/);
}));

test('★★★ a failed dispatch after the tag push: red; attempt 1 later only warns; a re-run re-dispatches', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.1');
  const before = w.push();
  const lost = w.run({ sha: c2, before, msg: 'Release v1.0.1', releases: ['v1.0.0'], dispatchFails: true });
  assert.notEqual(lost.status, 0, lost.out);
  assert.equal(w.tags()['v1.0.1'], c2, 'the tag was pushed before the dispatch failed');
  // Another first attempt (a later push's run) with the tag and no Release: warn, do not dispatch.
  const warn = w.run({ sha: c2, before, msg: 'Release v1.0.1', releases: ['v1.0.0'] });
  assert.equal(warn.status, 0, warn.out);
  assert.deepEqual(warn.dispatched, []);
  // The Release lookup fails (502, not a 404): red, and NOT a re-dispatch that would rebuild the version's images.
  for (const attempt of ['1', '2']) {
    const outage = w.run({ sha: c2, before, msg: 'Release v1.0.1', attempt, releases: ['v1.0.0'], lookupFails: true });
    assert.equal(outage.status, 1, outage.out);
    assert.match(outage.out, /::error::Could not look up the Release for v1\.0\.1 \(gh: Server Error \(HTTP 502\)\)/);
    assert.deepEqual(outage.dispatched, [], `attempt ${attempt}`);
  }
  // Re-run of the failed job: attempt 2, still no Release → re-dispatch.
  const rerun = w.run({ sha: c2, before, msg: 'Release v1.0.1', attempt: '2', releases: ['v1.0.0'] });
  assert.equal(rerun.status, 0, rerun.out);
  assert.deepEqual(rerun.dispatched, [dispatchOf('1.0.1')]);
  assert.equal(w.tags()['v1.0.1'], c2);
}));
