/**
 * tag-release.yml's tag step: the edge cases (see tagRelease.test.ts for the why and the core runs).
 *
 * A manual dispatch and a multi-commit push, every version spelling (what cannot be published is a
 * red run that tags nothing; what HA accepts is tagged), stray, pre-release and off-main tags, a
 * missing `before`, a multi-line message, a rejected tag push, and a commit that is not on main.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO, world, released100, dispatchOf } from './helpers/workflowRepo.js';

test('★★ workflow_dispatch: re-dispatches a tagged tip with no Release; tags an untagged tip at the commit that brought it', () => world((w) => {
  const c1 = released100(w);
  const tagged = w.run({ sha: c1, event: 'workflow_dispatch', msg: '', releases: [] });
  assert.equal(tagged.status, 0, tagged.out);
  assert.deepEqual(tagged.dispatched, [dispatchOf('1.0.0')]);
  const c2 = w.commit('1.0.1', 'Release v1.0.1');
  w.push();
  w.commit('1.0.1', 'later one');
  w.commit('1.0.1', 'later two');
  w.push();
  const tip = w.git(w.dev, 'rev-parse', 'HEAD');
  const r = w.run({ sha: tip, event: 'workflow_dispatch', msg: '', releases: ['v1.0.0'] });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.1'], c2, 'the first-parent walk finds the commit that brought 1.0.1');
  assert.deepEqual(r.dispatched, [dispatchOf('1.0.1')]);
}));

test('★★ a multi-commit push: tags its head even when the bump is not the head commit; two bumps → only the last', () => world((w) => {
  released100(w);
  w.commit('1.0.1', 'bump');
  const head = w.commit('1.0.1', 'other change');
  const before = w.push();
  const r = w.run({ sha: head, before, msg: 'other change', releases: ['v1.0.0'] });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.1'], head);
  w.commit('1.0.2', 'bump .2');
  const h2 = w.commit('1.0.3', 'bump .3');
  const b2 = w.push();
  const two = w.run({ sha: h2, before: b2, msg: 'bump .3', releases: ['v1.0.0', 'v1.0.1'] });
  assert.equal(two.status, 0, two.out);
  assert.equal(w.tags()['v1.0.3'], h2);
  assert.equal(w.tags()['v1.0.2'], undefined);
  assert.deepEqual(two.dispatched, [dispatchOf('1.0.3')]);
}));

test('★★★ a version that is not strict X.Y.Z, or is declared twice, is a red run and is never tagged', () => world((w) => {
  released100(w);
  const cases: Array<[string, { raw: string } | null]> = [
    ['pre-release', { raw: 'name: Power\nversion: "1.1.0-beta"\n' }],
    ['leading zero in the patch', { raw: 'version: "1.0.01"\n' }],
    ['leading zero in the major', { raw: 'version: "01.0.1"\n' }],
    ['empty value', { raw: 'name: Power\nversion:\n' }],
    ['emptied file (v0.16.2)', { raw: '' }],
    ['deleted file', null],
    ['declared twice', { raw: 'version: "1.0.1"\nname: Power\nversion: "1.0.2"\n' }],
  ];
  // One after another on main: each run judges its own commit first, whatever came before.
  for (const [label, cfg] of cases) {
    const sha = w.commit(cfg, label);
    const before = w.push();
    const r = w.run({ sha, before, msg: label, releases: ['v1.0.0'] });
    assert.equal(r.status, 1, `${label}: ${r.out}`);
    assert.match(r.out, /::error::config\.yaml at /, label);
    assert.deepEqual(Object.keys(w.tags()), ['v1.0.0'], label);
    assert.deepEqual(r.dispatched, [], label);
  }
}));

test('★★ version spellings HA accepts are tagged: single quotes, a trailing comment, numeric (not lexicographic) order', () => world((w) => {
  released100(w);
  const c2 = w.commit({ raw: "name: Power\nversion: '1.0.9'\n" }, 'quoted');
  let before = w.push();
  assert.equal(w.run({ sha: c2, before, msg: 'quoted', releases: ['v1.0.0'] }).status, 0);
  assert.equal(w.tags()['v1.0.9'], c2);
  const c3 = w.commit({ raw: 'name: Power\nversion: 1.0.10 # comment\n' }, 'comment');
  before = w.push();
  const r = w.run({ sha: c3, before, msg: 'comment', releases: ['v1.0.0', 'v1.0.9'] });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.10'], c3, '1.0.10 is above 1.0.9');
}));

test('★★ tags: a stray higher tag off main blocks (loudly); a pre-release tag is ignored; vV off main is an error; a later main commit is accepted', () => {
  world((w) => {
    const c1 = released100(w);
    w.tag('v9.9.9', w.side('stray', c1, '9.9.9'));
    const c2 = w.commit('1.0.1', 'Release v1.0.1');
    const before = w.push();
    const r = w.run({ sha: c2, before, msg: 'Release v1.0.1', releases: ['v1.0.0', 'v9.9.9'] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /not above v9\.9\.9/);
    assert.equal(w.tags()['v1.0.1'], undefined);
  });
  world((w) => {
    const c1 = released100(w);
    w.tag('v1.1.0-rc1', w.side('rc', c1, '1.1.0-rc1'));
    w.tag('v1.2.0.1', w.side('four', c1, '1.0.0'));
    const c2 = w.commit('1.0.1', 'Release v1.0.1');
    const before = w.push();
    const r = w.run({ sha: c2, before, msg: 'Release v1.0.1', releases: ['v1.0.0'] });
    assert.equal(r.status, 0, r.out);
    assert.equal(w.tags()['v1.0.1'], c2, 'non-strict tags do not raise the floor');
  });
  world((w) => {
    const c1 = released100(w);
    w.tag('v1.0.1', w.side('elsewhere', c1, '1.0.1'));
    const c2 = w.commit('1.0.1', 'Release v1.0.1');
    const before = w.push();
    const r = w.run({ sha: c2, before, msg: 'Release v1.0.1', releases: ['v1.0.0', 'v1.0.1'] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /::error::v1\.0\.1 points at .* which is not on main/);
  });
  world((w) => {
    released100(w);
    const c2 = w.commit('1.0.1', 'Release v1.0.1');
    const b2 = w.push();
    // A branch built on c2, tagged with c2's version before c2's run: a descendant, but not main.
    w.tag('v1.0.1', w.side('desc', c2, '1.0.1'));
    const r = w.run({ sha: c2, before: b2, msg: 'Release v1.0.1', releases: ['v1.0.0', 'v1.0.1'] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /not on main/);
  });
  world((w) => {
    released100(w);
    const c2 = w.commit('1.0.1', 'Release v1.0.1');
    const b2 = w.push();
    const c3 = w.commit('1.0.1', 'later');
    w.push();
    w.tag('v1.0.1', c3); // made by hand at a later main commit, before c2's run
    const r = w.run({ sha: c2, before: b2, msg: 'Release v1.0.1', releases: ['v1.0.0', 'v1.0.1'] });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.dispatched, []);
    assert.equal(w.tags()['v1.0.1'], c3);
  });
});

test('★★ BEFORE all zeros, or not in the clone, or HEAD_MSG unset: proceeds as for a dispatch', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'bump');
  w.commit('1.0.1', 'after');
  w.push();
  const tip = w.git(w.dev, 'rev-parse', 'HEAD');
  for (const before of [ZERO, 'f'.repeat(40), '']) {
    const r = w.run({ sha: tip, before, msg: null, releases: ['v1.0.0'] });
    assert.equal(r.status, 0, `${before}: ${r.out}`);
    assert.equal(w.tags()['v1.0.1'], c2, before);
    assert.deepEqual(r.dispatched, [dispatchOf('1.0.1')], before);
    w.untag('v1.0.1');
  }
}));

test('★ only the first line of the commit message is the subject', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'bump it');
  const before = w.push();
  const r = w.run({ sha: c2, before, msg: 'bump it\r\n\r\nRelease v9.9.9 is mentioned in the body', releases: ['v1.0.0'] });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.1'], c2);
  assert.match(r.out, /landed under the subject 'bump it'\./);
}));

test('★★★ a rejected tag push is a red run, and nothing is dispatched for a tag that does not exist', () => world((w) => {
  released100(w);
  const c2 = w.commit('1.0.1', 'Release v1.0.1');
  const before = w.push();
  w.rejectTagPushes();
  const r = w.run({ sha: c2, before, msg: 'Release v1.0.1', releases: ['v1.0.0'] });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(w.tags()['v1.0.1'], undefined);
  assert.deepEqual(r.dispatched, []);
}));

test('★★ a commit that is not on main (a dispatch from another branch) is never tagged', () => world((w) => {
  const c1 = released100(w);
  const s = w.side('feature', c1, '1.0.1');
  const r = w.run({ sha: s, event: 'workflow_dispatch', msg: '', releases: ['v1.0.0'] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not on main/);
  assert.deepEqual(Object.keys(w.tags()), ['v1.0.0']);
  assert.deepEqual(r.dispatched, []);
}));
