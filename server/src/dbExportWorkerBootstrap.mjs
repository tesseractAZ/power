// v1.107.0 — export-worker entry bootstrap.
//
// Same reason as analyticsWorkerBootstrap.mjs: the worker body is .ts, and
// tsx's ESM loader does not reliably propagate into worker threads in the
// add-on container. This .mjs loads natively, registers the loader for THIS
// thread, then imports the real worker.
let registered = false;
try {
  const { register } = await import('node:module');
  register('tsx/esm', import.meta.url);
  registered = true;
} catch {
  /* fall through to tsx's own API */
}
if (!registered) {
  const { register } = await import('tsx/esm/api');
  register();
}

await import('./dbExportWorker.ts');
