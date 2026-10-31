/**
 * serve.mts — the fixture fleet behind the real built web UI (v1.193.0).
 *
 * Serves web/dist statically, every GET /api path the UI reads from fixture.mts ROUTES, and the /ws
 * snapshot stream, on 127.0.0.1 only. It never acts: any request other than GET (and HEAD) is
 * answered 405, as is a GET to a path the UI only writes to (fixture.mts WRITE_ONLY). A GET to an
 * /api path the fixture does not serve — a history metric it does not model, or a write-only path
 * the UI has started to read — is answered 404 (405 for the write-only path) and remembered:
 * capture.mts refuses to write an image while that list is not empty, so a card that starts reading
 * a new endpoint is never photographed as an empty card. GET /__fixture/unknown lists them.
 *
 *   (cd server && node --import tsx ../scripts/screenshots/serve.mts)   http://127.0.0.1:8799/
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURE_NOW_MS, ROUTES, WRITE_ONLY, fixtureSnapshot, historyMetricKnown } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
export const DEFAULT_DIST = join(REPO, 'web', 'dist');
export const DEFAULT_PORT = 8799;

/** `ws` is the server package's own dependency (scripts/ has no node_modules of its own). */
interface WsClient { readyState: number; send(data: string): void; on(ev: 'close', fn: () => void): void }
interface WsServer { on(ev: 'connection', fn: (c: WsClient) => void): void; close(cb?: () => void): void; clients: Set<WsClient> }
const wsLib = createRequire(join(REPO, 'server', 'package.json'))('ws') as { WebSocketServer: new (o: { server: Server; path: string }) => WsServer };

/** One /ws frame: the snapshot, stamped with the fixture's clock as the server's send time. */
export function snapshotFrame(nowMs: number = FIXTURE_NOW_MS): string {
  return JSON.stringify({ type: 'snapshot', data: fixtureSnapshot(), serverNowMs: nowMs });
}

/** The trailing-slash-free path of a request, without its query ('/api/x/?a=1' → 'api/x'). */
const routeKey = (pathname: string): string => pathname.replace(/^\/+/, '').replace(/\/+$/, '');

/** WRITE_ONLY entries match their own path and anything under it ('api/device/refresh-cloud/<sn>'). */
const writeOnly = (key: string): boolean => Object.keys(WRITE_ONLY).some((w) => key === w || key.startsWith(`${w}/`));

/**
 * The answer to one /api request. PURE but for `unknown`, which collects what the fixture could not
 * serve. `body` is the JSON payload; null with a 404/405.
 */
export function route(method: string, pathAndQuery: string, unknown: Set<string>): { status: number; body: unknown } {
  const url = new URL(pathAndQuery, 'http://fixture.invalid');
  const key = routeKey(url.pathname);
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: null };
  if (writeOnly(key)) {
    // A read of a path the UI only writes to: refused, and reported. Unreported, the card that read
    // it would be photographed in its error state.
    unknown.add(`${key} (a read of a write-only path)`);
    return { status: 405, body: null };
  }
  const build = ROUTES[key];
  if (!build) {
    unknown.add(key);
    return { status: 404, body: null };
  }
  if (key === 'api/history') {
    const sn = url.searchParams.get('sn') ?? '';
    const metric = url.searchParams.get('metric') ?? '';
    if (!historyMetricKnown(sn, metric)) {
      unknown.add(`${key}?metric=${metric}`);
      return { status: 404, body: null };
    }
  }
  const body = build(url.searchParams);
  if (body == null) {
    unknown.add(`${key}?${url.searchParams.toString()}`);
    return { status: 404, body: null };
  }
  return { status: 200, body };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(distDir: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(distDir, rel);
  if (file !== distDir && !file.startsWith(distDir + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(buf);
  } catch {
    res.writeHead(404).end();
  }
}

export interface FixtureServer {
  url: string;
  port: number;
  /** /api paths (and history metrics) the page asked for that the fixture does not serve. */
  unknown: Set<string>;
  close(): Promise<void>;
}

export async function startFixtureServer(opts: { port?: number; distDir?: string; frameEveryMs?: number; nowMs?: () => number } = {}): Promise<FixtureServer> {
  const distDir = resolve(opts.distDir ?? DEFAULT_DIST);
  const now = opts.nowMs ?? (() => FIXTURE_NOW_MS);
  const unknown = new Set<string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathAndQuery = req.url ?? '/';
    const { pathname } = new URL(pathAndQuery, 'http://fixture.invalid');
    if (pathname === '/__fixture/unknown') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([...unknown].sort()));
      return;
    }
    if (pathname.startsWith('/api/')) {
      const { status, body } = route(req.method ?? 'GET', pathAndQuery, unknown);
      if (status !== 200) {
        res.writeHead(status).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    void serveStatic(distDir, pathname, res);
  });
  const wss = new wsLib.WebSocketServer({ server, path: '/ws' });
  const timers = new Set<NodeJS.Timeout>();
  wss.on('connection', (client) => {
    const send = () => { if (client.readyState === 1) client.send(snapshotFrame(now())); };
    send();
    const t = setInterval(send, opts.frameEveryMs ?? 5_000);
    timers.add(t);
    client.on('close', () => { clearInterval(t); timers.delete(t); });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? DEFAULT_PORT, '127.0.0.1', () => ok());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? DEFAULT_PORT);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    unknown,
    close: () => new Promise<void>((ok) => {
      for (const t of timers) clearInterval(t);
      timers.clear();
      for (const c of wss.clients) (c as unknown as { terminate(): void }).terminate();
      wss.close(() => server.close(() => ok()));
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const s = await startFixtureServer();
  console.log(`fixture fleet on ${s.url} (web/dist from ${DEFAULT_DIST}); Ctrl-C to stop`);
}
