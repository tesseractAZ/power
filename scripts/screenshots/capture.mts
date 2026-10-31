#!/usr/bin/env -S node --import tsx
/**
 * capture.mts — re-capture the five README screenshots from the fixture fleet (v1.193.0).
 *
 *   npm --prefix web ci && npm --prefix web run build      (once: the bundle the add-on ships)
 *   (cd server && node --import tsx ../scripts/screenshots/capture.mts)
 *
 * Starts serve.mts (the fixture fleet, 127.0.0.1:8799), drives headless Chrome over the DevTools
 * protocol through the real built UI at a fixed, standing clock (fixture.mts FIXTURE_NOW_MS,
 * America/Phoenix, en-US, 1280 CSS px wide at 2x, animations held at their first frame) and
 * photographs the Dashboard, Solar, Battery, Strategy and Alerts tabs into docs/screenshots/. An
 * unchanged fixture re-captures byte-identical images. macOS only: Chrome ($CHROME or
 * /Applications/Google Chrome.app), swiftc and sips.
 *
 * Every image passes these gates first, and ANY failure writes no image at all:
 *   (i)   the page asked for nothing the fixture does not serve, a read of a write-only path
 *         included (serve.mts `unknown`);
 *   (ii)  no card is still loading, and none reports itself unavailable;
 *   (iii) the page's text — innerText, every text node (SVG labels included) and the title, aria-label,
 *         alt and data-* attributes — passes leakGate.renderedTextProblems against the fixture's
 *         serials, with the tab's positive controls;
 *   (iv)  the same text passes `scripts/check-no-secrets.py --stdin` (its shape rules, and the
 *         owner's private value rules where configured);
 *   (v)   an OCR read of the full-resolution capture (ocr.swift) passes leakGate.ocrTextProblems,
 *         and so does a read of the downscaled image that is written;
 *   (vi)  where SCREENSHOT_PRIVATE_CHECK names an executable, the page text and both OCR reads go
 *         to it on stdin and it exits 0 (an owner-side check of values this public tree must not
 *         list; it is not part of the repository).
 * A fresh Chrome profile each run: the Default theme, and no cached bundle.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_NAMES, FIXTURE_NOW_MS, FIXTURE_SERIALS, PANEL_SN, SITE_ZONE } from './fixture.mjs';
import { ocrTextProblems, renderedTextProblems } from './leakGate.mjs';
import { DEFAULT_PORT, REPO, startFixtureServer, type FixtureServer } from './serve.mjs';

const OUT_DIR = join(REPO, 'docs', 'screenshots');
const WIDTH = 1280;
const SCALE = 2;
const OCR_MIN_LINES = 20;

/** The five tabs: the button label the header shows, the file, and what must be readable on it. */
export const TABS: ReadonlyArray<{ label: string; file: string; mustContain: readonly string[]; ocrMustContain: readonly string[] }> = [
  { label: 'Dashboard', file: 'dashboard.png', mustContain: ['Power', ...FIXTURE_NAMES, PANEL_SN], ocrMustContain: ['Power', 'Core 1'] },
  { label: 'Solar', file: 'solar.png', mustContain: ['Power', 'Core 1'], ocrMustContain: ['Power', 'Core 1'] },
  { label: 'Battery', file: 'battery.png', mustContain: ['Power', 'Core 1'], ocrMustContain: ['Power', 'Core 1'] },
  { label: 'Strategy', file: 'strategy.png', mustContain: ['Power', 'Circuit 1'], ocrMustContain: ['Power', 'Circuit 1'] },
  { label: 'Alerts', file: 'alerts.png', mustContain: ['Power', 'Smart Generator'], ocrMustContain: ['Power', 'Smart Generator'] },
];

/** A card still waiting for its data, or one that says its data did not come: never photographed. */
export const STILL_LOADING = /Loading view…|Loading forecast…|Loading…|Loading model-fit|Loading night-charge|Computing [a-z]|collecting…|Waiting for first snapshot/;
export const REPORTS_UNAVAILABLE = /unavailable — see add-on log|did not return a report|HTTP \d{3}/;

/** Newest modification time (ms) under `dir`, skipping node_modules and dist. */
export function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** The built bundle is missing (null dist time) or older than the source it was built from. */
export const distIsStale = (distBuiltMs: number | null, srcNewestMs: number): boolean => distBuiltMs == null || distBuiltMs < srcNewestMs;

/**
 * The page-side clock: Date.now() and new Date() read the fixture's clock and stand still there, so
 * the page's "now" equals the server's (the snapshot's send time) and every relative age it prints
 * is the same on every run. A dated Date is untouched.
 */
export function clockScript(nowMs: number): string {
  return `(() => {
  const Real = Date;
  const at = ${nowMs};
  function FixtureDate(...a) {
    if (!new.target) return new Real(at).toString();
    return a.length === 0 ? new Real(at) : new Real(...a);
  }
  FixtureDate.prototype = Real.prototype;
  FixtureDate.now = () => at;
  FixtureDate.parse = Real.parse;
  FixtureDate.UTC = Real.UTC;
  globalThis.Date = FixtureDate;
})();`;
}

/** The flow diagrams' dashes animate: held at their first frame from the start, a re-capture of an
 *  unchanged fixture is byte-identical. */
const HOLD_ANIMATIONS = `document.addEventListener('DOMContentLoaded', () => {
  const st = document.createElement('style');
  st.textContent = '*, *::before, *::after { animation-play-state: paused !important; animation-delay: 0s !important; }';
  document.head.appendChild(st);
});`;

/** Everything a viewer could read on the page, one item a line (scripts and styles left out). */
const DOM_TEXT = `(() => {
  const parts = [document.title, document.body.innerText];
  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const tag = n.parentElement ? n.parentElement.tagName : '';
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'style') continue;
    const v = (n.nodeValue || '').trim();
    if (v) parts.push(v);
  }
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) {
      if (a.value && (a.name === 'title' || a.name === 'aria-label' || a.name === 'alt' || a.name === 'placeholder' || a.name.startsWith('data-'))) parts.push(a.value);
    }
  }
  return parts.join('\\n');
})()`;

/* ── a minimal DevTools-protocol client ─────────────────────────────────── */

interface WsLike { send(d: string): void; on(ev: string, fn: (...a: unknown[]) => void): void; close(): void }
const wsLib = createRequire(join(REPO, 'server', 'package.json'))('ws') as { WebSocket: new (url: string, o: object) => WsLike };

type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };
class Cdp {
  private seq = 0;
  private pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  private listeners = new Set<(e: CdpEvent) => void>();
  private constructor(private ws: WsLike) {
    ws.on('message', (data: unknown) => {
      const m = JSON.parse(String(data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (m.id != null) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.fail(new Error(m.error.message));
        else p?.ok(m.result ?? {});
      } else if (m.method) {
        for (const l of this.listeners) l({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
      }
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new wsLib.WebSocket(url, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
      ws.on('open', () => ok(new Cdp(ws)));
      ws.on('error', (e) => fail(e as Error));
    });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  on(fn: (e: CdpEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  close(): void { this.ws.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** /api requests in flight on the page, and when that last changed. */
export class ApiIdle {
  private inflight = new Set<string>();
  private changedAt: number;
  readonly seen = new Set<string>();
  constructor(private clock: () => number = Date.now) { this.changedAt = clock(); }
  started(id: string, url: string): void {
    const u = new URL(url);
    if (!u.pathname.startsWith('/api/')) return;
    this.seen.add(u.pathname);
    this.inflight.add(id);
    this.changedAt = this.clock();
  }
  ended(id: string): void {
    if (this.inflight.delete(id)) this.changedAt = this.clock();
  }
  /** No /api request in flight for at least `quietMs`. */
  idle(quietMs: number): boolean { return this.inflight.size === 0 && this.clock() - this.changedAt >= quietMs; }
}

async function launchChrome(profile: string): Promise<{ proc: ChildProcess; wsUrl: string }> {
  const bin = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((ok, fail) => {
    let buf = '';
    const t = setTimeout(() => fail(new Error('Chrome did not open its DevTools port within 20 s')), 20_000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); ok(m[1]); }
    });
    proc.once('exit', (code) => { clearTimeout(t); fail(new Error(`Chrome exited (${code}) before its DevTools port opened`)); });
    proc.once('error', (e) => { clearTimeout(t); fail(e); });
  });
  return { proc, wsUrl };
}

interface Shot { tab: (typeof TABS)[number]; master: string; cssW: number; cssH: number; endpoints: number; domChars: number; ocrLines: number }

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.error('capture: macOS only (Vision OCR via swiftc, sips).');
    return 2;
  }
  const dist = join(REPO, 'web', 'dist', 'index.html');
  let distBuilt: number | null = null;
  try { distBuilt = statSync(dist).mtimeMs; } catch { distBuilt = null; }
  const srcNewest = Math.max(newestMtimeMs(join(REPO, 'web', 'src')), statSync(join(REPO, 'web', 'index.html')).mtimeMs);
  if (distIsStale(distBuilt, srcNewest)) {
    console.error('capture: web/dist is missing or older than web/src. Build it first (with web/ own node_modules):\n  npm --prefix web ci && npm --prefix web run build');
    return 2;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'power-shots-'));
  const profile = join(tmp, 'profile');
  const ocrBin = join(tmp, 'ocr');
  let server: FixtureServer | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    execFileSync('swiftc', ['-O', '-o', ocrBin, join(REPO, 'scripts', 'screenshots', 'ocr.swift')], { stdio: 'inherit' });
    const ocr = (png: string): string[] => execFileSync(ocrBin, [png], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').map((l) => l.trim()).filter(Boolean);

    server = await startFixtureServer({ port: Number(process.env.SCREENSHOT_PORT ?? DEFAULT_PORT) });
    const launched = await launchChrome(profile);
    chrome = launched.proc;
    cdp = await Cdp.open(launched.wsUrl);
    const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    const s = (method: string, params: Record<string, unknown> = {}) => cdp!.send(method, params, sessionId);
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const r = (await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as { result: { value: T }; exceptionDetails?: { text: string } };
      if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text}`);
      return r.result.value;
    };

    await s('Page.enable');
    await s('Runtime.enable');
    await s('Network.enable');
    await s('Emulation.setTimezoneOverride', { timezoneId: SITE_ZONE });
    await s('Emulation.setLocaleOverride', { locale: 'en-US' });
    await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: clockScript(FIXTURE_NOW_MS) });
    await s('Page.addScriptToEvaluateOnNewDocument', { source: HOLD_ANIMATIONS });

    let idle = new ApiIdle();
    let loaded = false;
    cdp.on((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.method === 'Network.requestWillBeSent') idle.started(String(e.params.requestId), String((e.params.request as { url: string }).url));
      else if (e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') idle.ended(String(e.params.requestId));
      else if (e.method === 'Page.loadEventFired') loaded = true;
    });
    const waitFor = async (what: string, test: () => boolean | Promise<boolean>, capMs = 20_000): Promise<void> => {
      const t0 = Date.now();
      while (!(await test())) {
        if (Date.now() - t0 > capMs) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    };
    const waitIdle = () => waitFor('the page\'s /api requests to settle', () => idle.idle(1_500));
    const pageText = () => evaluate<string>('document.body.innerText');

    const shots: Shot[] = [];
    for (const tab of TABS) {
      // A fresh load per tab: the page clock restarts at FIXTURE_NOW_MS, so every tab reads the same.
      await s('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: SCALE, mobile: false });
      idle = new ApiIdle();
      loaded = false;
      await s('Page.navigate', { url: server.url });
      await waitFor('the page to load', () => loaded);
      await waitFor('the first snapshot', async () => / devices · \d+ online/.test(await pageText()));
      const clicked = await evaluate<boolean>(`(() => { const b = [...document.querySelectorAll('header button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(tab.label)})); if (!b) return false; b.click(); return true; })()`);
      if (!clicked) throw new Error(`${tab.label}: no tab button`);
      await waitIdle();
      await sleep(2_000);
      await evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
      await sleep(500);
      await evaluate('window.scrollTo(0, 0)');
      await waitIdle();
      await waitFor(`${tab.label}: every card to finish loading`, async () => !STILL_LOADING.test(await pageText()));

      // The full page in one frame: the viewport made as tall as the document, then settled again.
      let cssH = await evaluate<number>('document.documentElement.scrollHeight');
      await s('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: cssH, deviceScaleFactor: SCALE, mobile: false });
      await sleep(800);
      await waitIdle();
      cssH = await evaluate<number>('document.documentElement.scrollHeight');

      const problems: string[] = [];
      if (server.unknown.size > 0) problems.push(`the page asked for what the fixture does not serve: ${[...server.unknown].sort().join(', ')}`);
      const text = await pageText();
      if (STILL_LOADING.test(text)) problems.push('a card is still loading');
      if (REPORTS_UNAVAILABLE.test(text)) problems.push('a card reports its data unavailable');
      const dom = await evaluate<string>(DOM_TEXT);
      problems.push(...renderedTextProblems(dom, { serials: new Set(FIXTURE_SERIALS), mustContain: tab.mustContain }));
      const scan = spawnSync('python3', ['-I', '-B', join(REPO, 'scripts', 'check-no-secrets.py'), '--stdin'], { input: dom, encoding: 'utf8' });
      if (scan.status !== 0) problems.push(`check-no-secrets.py --stdin: ${(scan.stderr || scan.stdout).trim().split('\n').slice(1).join('; ') || `exit ${scan.status}`}`);

      const shot = (await s('Page.captureScreenshot', { format: 'png', fromSurface: true, clip: { x: 0, y: 0, width: WIDTH, height: cssH, scale: 1 } })) as { data: string };
      const master = join(tmp, `master-${tab.file}`);
      writeFileSync(master, Buffer.from(shot.data, 'base64'));
      const lines = ocr(master);
      problems.push(...ocrTextProblems(lines, { mustContain: tab.ocrMustContain, minLines: OCR_MIN_LINES }).map((p) => `OCR: ${p}`));
      if (process.env.SCREENSHOT_PRIVATE_CHECK) {
        const priv = spawnSync(process.env.SCREENSHOT_PRIVATE_CHECK, [], { input: `${dom}\n${lines.join('\n')}`, encoding: 'utf8' });
        if (priv.status !== 0) problems.push(`SCREENSHOT_PRIVATE_CHECK exited ${priv.status}`);
      }
      if (problems.length) {
        console.error(`capture: ${tab.label} FAILED — no image written:\n  ${problems.join('\n  ')}`);
        return 1;
      }
      shots.push({ tab, master, cssW: WIDTH, cssH, endpoints: idle.seen.size, domChars: dom.length, ocrLines: lines.length });
    }

    // Every tab passed: downscale, read each written image once more, and only then replace the five.
    const finals: Array<{ shot: Shot; final: string; lines: number }> = [];
    for (const shot of shots) {
      const final = join(tmp, shot.tab.file);
      execFileSync('sips', ['--resampleWidth', String(WIDTH), shot.master, '--out', final], { stdio: 'ignore' });
      const lines = ocr(final);
      const problems = ocrTextProblems(lines, { mustContain: shot.tab.ocrMustContain, minLines: OCR_MIN_LINES });
      if (process.env.SCREENSHOT_PRIVATE_CHECK) {
        const priv = spawnSync(process.env.SCREENSHOT_PRIVATE_CHECK, [], { input: lines.join('\n'), encoding: 'utf8' });
        if (priv.status !== 0) problems.push(`SCREENSHOT_PRIVATE_CHECK exited ${priv.status}`);
      }
      if (problems.length) {
        console.error(`capture: ${shot.tab.label} (downscaled) FAILED — no image written:\n  ${problems.join('\n  ')}`);
        return 1;
      }
      finals.push({ shot, final, lines: lines.length });
    }
    for (const { shot, final, lines } of finals) {
      const dest = join(OUT_DIR, shot.tab.file);
      copyFileSync(final, dest);
      const px = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', dest], { encoding: 'utf8' }).match(/\d+/g)?.slice(-2).join('x') ?? '?';
      console.log(`${shot.tab.label.padEnd(9)} ${shot.cssW}x${shot.cssH} CSS · ${shot.endpoints} endpoints · DOM ${shot.domChars} chars clean · OCR ${shot.ocrLines}/${lines} lines clean · ${px} px · ${statSync(dest).size} B → docs/screenshots/${shot.tab.file}`);
    }
    return 0;
  } finally {
    try { cdp?.close(); } catch { /* closing */ }
    if (chrome && chrome.exitCode == null) {
      const exited = new Promise((r) => chrome!.once('exit', r));
      chrome.kill('SIGKILL');
      await Promise.race([exited, sleep(5_000)]);
    }
    await server?.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
