// Git smart HTTP: protocol v2 upload-pack, v0 fallback, v0 receive-pack.
// pkt-line framing, side-band-64k pack delivery, shallow/deepen, report-status.
// The suite client sends plain-object packs only (no deltas); the server sends
// plain-object packs only (deltas are permitted, never required).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  writePack,
  readPack,
  collectReachable,
  isDescendant,
  peelToCommit,
  parseCommit,
  parseTag,
  parseTree,
  hashObject,
  storeObject,
  walkCommits,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';
import { authOk, sendJson, nextRequestId } from './util.ts';

const AGENT = 'git-forge/1.0';
const MAX_PKT = 65520;

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Parse a pkt-line stream into lines. Returns lines (strings) and byte offset consumed. */
export function parsePktLines(buf: Buffer): { lines: string[]; raw: Buffer[] } {
  const lines: string[] = [];
  const raw: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) {
      lines.push('\0flush');
      raw.push(buf.subarray(off, off + 4));
      off += 4;
      continue;
    }
    if (len === 1) {
      // Delimiter packet (0001) separating v2 argument sections.
      lines.push('\0delim');
      raw.push(buf.subarray(off, off + 4));
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    const payload = buf.subarray(off + 4, off + len);
    lines.push(payload.toString('utf8'));
    raw.push(buf.subarray(off, off + len));
    off += len;
  }
  return { lines, raw };
}

/** Byte offset just after the pkt-line section (through the first flush). */
export function pktSectionEnd(buf: Buffer): number {
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return off;
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) return off + 4;
    if (len < 4 || off + len > buf.length) return off;
    off += len;
  }
  return off;
}

// ---------------------------------------------------------------------------
// Object selection for fetch
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Oids to put in the pack (commits + trees + blobs). */
  objects: Set<string>;
  /** Boundary commits to report as shallow. */
  shallow: string[];
  /** Former shallow commits that are now fully present. */
  unshallow: string[];
}

/**
 * Compute the fetch pack: depth-limited closure of wants minus the full
 * closure of haves. Depth counts commits from the wants (1 = wants only).
 */
export function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, shallowKnown: string[]): FetchPlan {
  const objects = repo.objects;
  // Commits within depth of wants.
  const wantedCommits = new Map<string, number>(); // oid -> distance
  const queue: [string, number][] = wants.map((w) => [w, 0] as [string, number]);
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const [oid, dist] = queue.shift() as [string, number];
    if (seenCommit.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.bytes).object;
      queue.push([target, dist]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    seenCommit.add(oid);
    wantedCommits.set(oid, dist);
    if (depth === null || dist + 1 < depth) {
      for (const p of parseCommit(obj.bytes).parents) queue.push([p, dist + 1]);
    }
  }
  // Boundary = wanted commits at max depth (their parents excluded) or whose
  // parents are outside the wanted set.
  const shallow: string[] = [];
  for (const [oid, dist] of wantedCommits) {
    if (depth !== null && dist === depth - 1) {
      shallow.push(oid);
      continue;
    }
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.bytes).parents;
    if (parents.some((p) => !wantedCommits.has(p)) && parents.length > 0) shallow.push(oid);
  }
  // Everything reachable from wants (trees/blobs of wanted commits + tags).
  // NOTE: this must NOT use collectReachable on the commits: that walks
  // parents unconditionally and would leak history past the depth limit.
  // Only the depth-limited wantedCommits (plus tag objects) are included,
  // each with its own tree closure (trees/blobs have no depth).
  const out = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.bytes)) stack.push(entry.oid);
      }
    }
  };
  for (const oid of wantedCommits.keys()) {
    out.add(oid);
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') addTreeClosure(parseCommit(obj.bytes).tree);
  }
  for (const w of wants) {
    const obj = objects.get(w);
    if (obj && obj.type === 'tag') out.add(w);
  }
  const wantClosure = out;
  // Exclude everything reachable from haves — but a shallow boundary have
  // contributes only itself and its tree, not its (absent) parents.
  const haveClosure = collectReachable(objects, haves, new Set(shallowKnown));
  for (const oid of haveClosure) out.delete(oid);
  // Unshallow: a known-shallow commit whose parent is now in the pack (or in
  // the have closure, i.e. fully present now).
  const unshallow: string[] = [];
  for (const s of shallowKnown) {
    const obj = objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.bytes).parents;
    if (parents.length === 0) continue;
    if (parents.every((p) => out.has(p) || haveClosure.has(p))) unshallow.push(s);
  }
  return { objects: out, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function refLines(repo: Repo): { oid: string; ref: string; peeled?: string }[] {
  const out: { oid: string; ref: string; peeled?: string }[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj && obj.type === 'tag') {
      peeled = peelToCommit(repo.objects, oid) ?? undefined;
    }
    out.push({ oid, ref, peeled });
  }
  return out;
}

function headTip(repo: Repo): string | null {
  const oid = repo.refs.get('refs/heads/main');
  if (!oid) return null;
  return peelToCommit(repo.objects, oid);
}

const UPLOAD_V0_CAPS = `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function advertiseV0(service: string, caps: string, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headTip(repo) ?? refs[0].oid;
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.ref}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(repo: Repo): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 ls-refs / fetch
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  const matches = (ref: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => ref.startsWith(p));
  if (args.symrefs && matches('HEAD')) {
    const tip = headTip(repo);
    if (tip === null) {
      if (args.unborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/main\n`));
    }
  }
  for (const r of refs) {
    if (!matches(r.ref)) continue;
    let line = `${r.oid} ${r.ref}`;
    if (r.peeled && args.peel) line += ` peeled:${r.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(off + 32768, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // An empty pack still needs at least one sideband packet.
    out.push(pktLine(Buffer.from([1])));
  }
  return out;
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('want ')) wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) shallowKnown.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) {
      const n = Number.parseInt(l.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallowKnown);
  const pack = writePack(repo.objects, plan.objects);
  // v2 sections are separated by FLUSH pkt-lines (the client resets its section on flush).
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowKnown: string[] = [];
  let depth: number | null = null;
  let section = 0; // 0 = wants, 1 = haves
  for (const line of lines) {
    const l = line.trim();
    if (l === '\0flush') {
      section = 1;
      continue;
    }
    if (l.startsWith('want ')) wants.push(l.slice(5).split(' ')[0]);
    else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) shallowKnown.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) {
      const n = Number.parseInt(l.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    void section;
  }
  const plan = planFetch(repo, wants, haves, depth, shallowKnown);
  const pack = writePack(repo.objects, plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const end = pktSectionEnd(body);
  const { lines } = parsePktLines(body.subarray(0, end));
  const commands: PushCommand[] = [];
  for (const line of lines) {
    if (line === '\0flush') continue;
    // First command line carries NUL-separated capabilities after the ref; strip them.
    const cmd = line.split('\0')[0];
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)/.exec(cmd.trim());
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(end);
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  let unpackOk = true;
  let unpackErr = '';
  // Unpack first (delete-only pushes carry no pack bytes).
  const newObjects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      for (const o of parsed.objects) {
        newObjects.set(o.oid, { type: o.type, bytes: o.bytes });
      }
    } catch (e) {
      unpackOk = false;
      unpackErr = e instanceof Error ? e.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: unpackErr });
      continue;
    }
    const current = repo.refs.get(cmd.ref) ?? null;
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old oid mismatch' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    if (current === null) {
      // Create.
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old oid mismatch' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    // Update: must be a fast-forward.
    if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old oid mismatch' });
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (!isDescendant(repo.objects, cmd.newOid, current)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  const parts: Buffer[] = [];
  const band = (text: string): Buffer => pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(text, 'utf8')]));
  parts.push(band(unpackOk ? 'unpack ok\n' : `unpack ${unpackErr}\n`));
  for (const r of results) {
    parts.push(band(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const REPO_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Buffer | null,
): void {
  const m = REPO_PATH.exec(path);
  if (!m) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const [, owner, repoName, action] = m;
  if (!authOk(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const sendRaw = (status: number, contentType: string, buf: Buffer): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': buf.length,
      'x-github-request-id': nextRequestId(),
    });
    res.end(buf);
  };
  if (action === 'info/refs') {
    let service = '';
    try {
      service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
    } catch {
      service = '';
    }
    if (service === 'git-upload-pack') {
      const proto = (req.headers['git-protocol'] ?? '').toString();
      if (proto.includes('version=2')) {
        sendRaw(200, 'application/x-git-upload-pack-advertisement', advertiseV2(repo));
      } else {
        sendRaw(200, 'application/x-git-upload-pack-advertisement', advertiseV0('git-upload-pack', UPLOAD_V0_CAPS, repo));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(200, 'application/x-git-receive-pack-advertisement', advertiseV0('git-receive-pack', RECEIVE_CAPS, repo));
      return;
    }
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  if (body === null) {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  if (action === 'git-upload-pack') {
    const { lines } = parsePktLines(body);
    const first = lines[0] ?? '';
    let out: Buffer;
    if (first.startsWith('command=ls-refs')) {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      let seenDelim = false;
      for (const line of lines.slice(1)) {
        if (line === '\0flush') break;
        if (line === '\0delim') {
          seenDelim = true;
          continue;
        }
        if (!seenDelim) continue;
        const l = line.trim();
        if (l === 'peel') args.peel = true;
        else if (l === 'symrefs') args.symrefs = true;
        else if (l === 'unborn') args.unborn = true;
        else if (l.startsWith('ref-prefix ')) args.prefixes.push(l.slice(11).trim());
      }
      // Defaults per the client: peel/symrefs/unborn are sent unless disabled;
      // the request lists them explicitly, so the parsed flags are authoritative.
      out = handleLsRefs(repo, args);
    } else if (first.startsWith('command=fetch')) {
      out = handleFetchV2(repo, lines.slice(1));
    } else if (first.startsWith('want ')) {
      out = handleFetchV0(repo, lines);
    } else {
      // Malformed: stay alive, answer an empty fetch-style response.
      out = Buffer.concat([pktLine('NAK\n'), ...sidebandPack(writePack(repo.objects, [])), FLUSH]);
    }
    sendRaw(200, 'application/x-git-upload-pack-result', out);
    return;
  }
  if (action === 'git-receive-pack') {
    const out = handleReceivePack(repo, body);
    sendRaw(200, 'application/x-git-receive-pack-result', out);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

export { createHash, walkCommits };
