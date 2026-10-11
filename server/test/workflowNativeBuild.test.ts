/**
 * The image builds run natively, so no workflow needs QEMU (and its Docker Hub pull).
 *
 * images.yml builds each arch on its own runner and targets only that runner's platform;
 * ci.yml's smoke build targets linux/amd64 on an x64 runner. docker/setup-qemu-action only
 * registers binfmt emulators for running another architecture's binaries, which none of
 * these builds does, so it is not in any workflow. A matrix edit that pairs a platform with
 * the other arch's runner would need emulation again, and fails here instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const read = (f: string) => readFileSync(resolve(DIR, f), 'utf8');
const IMAGES = read('images.yml');
const CI = read('ci.yml');

const isArmRunner = (r: string) => /-arm$/.test(r);

test('★★ images.yml: each matrix entry builds only its own runner\'s platform', () => {
  const block = /^ {8}include:\n((?:^ {10}.*\n|^\s*\n)+)/m.exec(IMAGES);
  assert.ok(block, 'matrix include block not found');
  const entries = block[1].split(/^ {10}- /m).slice(1);
  assert.equal(entries.length, 2, `${entries.length} matrix entries`);
  for (const e of entries) {
    const platform = /^(?:\s*)platform: (\S+)$/m.exec(e)?.[1];
    const runner = /^(?:\s*)runner: (\S+)$/m.exec(e)?.[1];
    assert.ok(platform && runner, `entry without platform or runner: ${e.trim().split('\n')[0]}`);
    assert.ok(platform === 'linux/arm64' || platform === 'linux/amd64', `one platform per entry: ${platform}`);
    assert.equal(isArmRunner(runner!), platform === 'linux/arm64', `${platform} on ${runner} needs emulation`);
  }
  assert.match(IMAGES, /^ {10}platforms: \$\{\{ matrix\.platform \}\}$/m);
  assert.match(IMAGES, /^ {4}runs-on: \$\{\{ matrix\.runner \}\}$/m);
});

test('★★ ci.yml: the smoke build targets linux/amd64 on an x64 runner', () => {
  const at = CI.indexOf('\n  docker-smoke:\n');
  assert.ok(at >= 0, 'docker-smoke job not found');
  const job = CI.slice(at, CI.indexOf('\n  docs-docx:\n'));
  const runner = /^ {4}runs-on: (\S+)$/m.exec(job)?.[1];
  assert.ok(runner && !isArmRunner(runner), `runner ${runner}`);
  assert.match(job, /^ {10}platforms: linux\/amd64$/m);
});

test('★ no workflow runs docker/setup-qemu-action', () => {
  const hits = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) => read(f).split('\n').map((l, i) => [f, i + 1, l] as const))
    .filter(([, , l]) => /^\s*(?:-\s+)?uses:\s*docker\/setup-qemu-action@/.test(l));
  assert.deepEqual(hits.map(([f, n]) => `${f}:${n}`), []);
});
