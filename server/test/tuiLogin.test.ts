import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLogin, type LoginViewState } from '../src/console/login.js';

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const base: LoginViewState = { stage: 'username', user: '', passLen: 0, attemptsLeft: 3, error: null };

const STATES: LoginViewState[] = [
  base,
  { ...base, user: 'o' },
  { ...base, user: 'operator' },
  { ...base, user: 'x'.repeat(64) },
  { ...base, user: 'operator', stage: 'password' },
  { ...base, user: 'operator', stage: 'password', passLen: 7 },
  { ...base, user: 'operator', stage: 'password', passLen: 64 },
  { ...base, error: 'Invalid username or password', attemptsLeft: 2 },
];

/** The column of each field box's left edge, read from the row that holds its label. */
function edges(lines: string[]): { user: number; pass: number } {
  const at = (label: string) => {
    const l = lines.map(plain).find((x) => x.includes(label));
    assert.ok(l, `a row labelled ${label}`);
    return l.indexOf('│');
  };
  return { user: at('User ID'), pass: at('Password') };
}

for (const [w, h] of [[80, 24], [120, 40], [44, 20]] as const) {
  test(`login ${w}×${h}: typing never moves the fields (v1.191.5)`, () => {
    const first = edges(renderLogin(base, w, h));
    for (const st of STATES) {
      const lines = renderLogin(st, w, h);
      assert.equal(lines.length, h - 1, 'one line per terminal row but the last, as before');
      assert.deepEqual(edges(lines), first, `the boxes stay put for ${JSON.stringify({ ...st, user: st.user.length })}`);
      const panel = lines.map(plain).filter((l) => /[╔║╚]/.test(l));
      const widths = new Set(panel.map((l) => l.trimEnd().length));
      assert.equal(widths.size, 1, `every panel row is one width: ${[...widths].join(', ')}`);
      for (const l of lines) assert.ok(plain(l).length <= w, `no row is wider than the terminal: ${plain(l).length}`);
    }
  });
}

test('login: a long value shows its tail and the cursor inside the box; the password is masked', () => {
  const user = 'a'.repeat(40) + 'TAIL';
  const row = renderLogin({ ...base, user }, 80, 24).map(plain).find((l) => l.includes('User ID'))!;
  assert.match(row, /TAIL█ │/, row);
  const pw = renderLogin({ ...base, user: 'operator', stage: 'password', passLen: 5 }, 80, 24).map(plain);
  assert.ok(pw.some((l) => l.includes('Password') && l.includes('*****█')), pw.join('\n'));
  assert.ok(pw.some((l) => l.includes('User ID') && l.includes('operator')), 'the username stays shown on the password step');
});

test('login: no standing hint lines; an error is reported below the panel (v1.191.6)', () => {
  const idle = renderLogin(base, 80, 24).map(plain).join('\n');
  assert.doesNotMatch(idle, /ENTER=Submit|BACKSPACE|add-on configuration/);
  const denied = renderLogin({ ...base, error: 'Invalid username or password', attemptsLeft: 2 }, 80, 24).map(plain);
  const panelEnd = denied.findIndex((l) => l.includes('╚'));
  assert.ok(denied.slice(panelEnd + 1).some((l) => l.includes('Invalid username or password — 2 attempt(s) remaining')));
});

test('login: the banner is drawn only when the terminal has the rows for it', () => {
  assert.ok(renderLogin(base, 100, 30).map(plain).some((l) => l.includes('P L A N T   S T A T U S   S Y S T E M')));
  assert.ok(!renderLogin(base, 80, 24).map(plain).some((l) => l.includes('P L A N T')));
  assert.ok(renderLogin(base, 80, 24).map(plain).some((l) => l.includes('SIGN ON')));
});
