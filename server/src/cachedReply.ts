import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * v0.9.14 — cache helper for read-mostly endpoints.
 *
 * Adds a strong ETag (sha-1 of the payload), short Cache-Control max-age,
 * and short-circuits with 304 Not Modified when the client's
 * `If-None-Match` matches. Use on endpoints where the same response is
 * safely re-served for a few seconds (history, ha-state, summary/today).
 *
 * Does NOT mutate `body` — returns it for chaining: `return cached(req, reply, payload, 30)`.
 *
 * v0.9.27 — fixed Fastify lifecycle bug. When ETag matched, the code
 * called `reply.code(304).send()` AND returned `body`. Fastify then
 * tried to serialize + send `body` onto the already-closed stream,
 * producing 223+ "Reply was already sent" warnings in 2 hours of
 * normal traffic across 17 endpoints (every endpoint that uses this
 * helper). Fix: return `reply` itself when we manually send — Fastify
 * recognizes a returned FastifyReply as "already handled, skip
 * serialization". Cast through `unknown as T` because every call site
 * just hands the return value back to Fastify; nobody inspects it.
 *
 * Moved out of index.ts (where it lived inline) so a route's window and its caching can be
 * exercised together over `inject()`: the cleared-alert history (clearedHistory.ts) varies its
 * body by query string, and each window must carry its own ETag.
 */
export function cached<T>(req: FastifyRequest, reply: FastifyReply, body: T, maxAgeSec = 30): T {
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(json).digest('base64').slice(0, 22)}"`;
  reply.header('Cache-Control', `private, max-age=${maxAgeSec}`);
  reply.header('ETag', etag);
  const inm = req.headers['if-none-match'];
  if (inm && inm === etag) {
    return reply.code(304).send() as unknown as T;
  }
  return body;
}
