// Shared helpers: deterministic ids, fixed timestamps, JSON replies, auth.
// No wall-clock time is ever emitted into a response body (determinism rule).

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Scenario epoch: 2025-01-01T00:00:00Z. All emitted timestamps derive from this. */
export const EPOCH_SEC = 1735689600;
export const FIXED_TS = '2025-01-01T00:00:00Z';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;
export const TEAMMATE = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid' } as const;
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid' } as const;
export const ORG = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';

let reqCounter = 0;
export function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

/** Bearer <redacted> check. Empty env token (local manual runs) accepts everything. */
export function authOk(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  const got = req.headers.authorization ?? '';
  return got === `Bearer ${expected}`;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendErr(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { message }, headers);
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body (bounded). Returns null on oversize. */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!done) resolve(null);
    });
  });
}

/** Parse a JSON body; returns {ok:false} on malformed JSON. */
export function parseJson(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Opaque global id for a repo / issue / PR / comment. Stable, never the numeric id. */
export function gid(kind: string, key: string): string {
  return b64urlEncode(`${kind}:${key}`);
}

export function isSha40(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s);
}

/** Link header for paginated lists. */
/** Absolute origin of this request (the entry is plain HTTP on loopback). */
export function requestOrigin(req: IncomingMessage): string {
  const host = (req.headers.host ?? '127.0.0.1').toString();
  return `http://${host}`;
}

/** GitHub-style Link header with ABSOLUTE urls (the suite's sameOrigin() rejects relative ones). */
export function linkHeader(req: IncomingMessage, base: string, page: number, perPage: number, total: number): string {
  const last = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const url = (p: number): string => `<${requestOrigin(req)}${base}?page=${p}&per_page=${perPage}>`;
  if (page < last) {
    parts.push(`${url(page + 1)}; rel="next"`);
    parts.push(`${url(last)}; rel="last"`);
  }
  if (page > 1) {
    parts.push(`${url(1)}; rel="first"`);
    parts.push(`${url(page - 1)}; rel="prev"`);
  }
  return parts.join(', ');
}

export function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}
