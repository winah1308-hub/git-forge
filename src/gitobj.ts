// Pure git object layer: SHA-1 ids, loose objects, packfile read/write (plain
// objects only — the suite client never sends deltas, and may receive none),
// trees, commits, tags, reachability. No I/O, no time, no randomness.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflateSync, deflateSync as zlibDeflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  bytes: Buffer;
}

export function hashObject(type: ObjType, bytes: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjType, bytes: Buffer): string {
  const oid = hashObject(type, bytes);
  if (!objects.has(oid)) objects.set(oid, { type, bytes });
  return oid;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644' | '40000' (only modes the suite exercises)
  name: string;
  oid: string;
}

/** Parse a raw tree body into entries. */
export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < bytes.length) {
    const sp = bytes.indexOf(0x20, off);
    const mode = bytes.subarray(off, sp).toString('ascii');
    const nul = bytes.indexOf(0x00, sp + 1);
    const name = bytes.subarray(sp + 1, nul).toString('utf8');
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Serialize entries git-style: sorted with directory names compared as if suffixed with '/'. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/**
 * Set a path in a tree (creating intermediate trees), returning the new root
 * tree oid. `value` null deletes the path. All intermediate objects are stored.
 */
export function treeSet(
  objects: Map<string, GitObject>,
  rootOid: string | null,
  path: string,
  value: { mode: string; oid: string } | null,
): string {
  const parts = path.split('/').filter((p) => p !== '');
  return setIn(objects, rootOid, parts, value);
}

function setIn(
  objects: Map<string, GitObject>,
  rootOid: string | null,
  parts: string[],
  value: { mode: string; oid: string } | null,
): string {
  const entries = rootOid !== null ? parseTree(objects.get(rootOid)?.bytes ?? Buffer.alloc(0)) : [];
  const [head, ...rest] = parts;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (value === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: value.mode, name: head, oid: value.oid };
    } else {
      entries.push({ mode: value.mode, name: head, oid: value.oid });
    }
  } else {
    const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    const newChild = setIn(objects, child, rest, value);
    // Prune empty directories.
    const childEntries = parseTree(objects.get(newChild)?.bytes ?? Buffer.alloc(0));
    if (childEntries.length === 0 && value === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: newChild };
    } else {
      entries.push({ mode: '40000', name: head, oid: newChild });
    }
  }
  return storeObject(objects, 'tree', buildTree(entries));
}

/** Read a file's blob oid from a tree, following nested paths. */
export function treeGet(objects: Map<string, GitObject>, rootOid: string | null, path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  let cur = rootOid;
  for (let i = 0; i < parts.length; i += 1) {
    if (cur === null) return null;
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const e = parseTree(obj.bytes).find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e.mode === '100644' ? e.oid : null;
    cur = e.oid;
  }
  return null;
}

/** List direct children of a directory path in a tree. null = not a directory. */
export function treeList(
  objects: Map<string, GitObject>,
  rootOid: string | null,
  path: string,
): { name: string; path: string; mode: string; oid: string }[] | null {
  const parts = path.split('/').filter((p) => p !== '');
  let cur = rootOid;
  for (const part of parts) {
    if (cur === null) return null;
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const e = parseTree(obj.bytes).find((x) => x.name === part);
    if (!e || e.mode !== '40000') return null;
    cur = e.oid;
  }
  if (cur === null) return [];
  const obj = objects.get(cur);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.bytes).map((e) => ({
    name: e.name,
    path: parts.length > 0 ? `${parts.join('/')}/${e.name}` : e.name,
    mode: e.mode,
    oid: e.oid,
  }));
}

/** Flatten a tree into path -> blob oid. */
export function treeFlatten(objects: Map<string, GitObject>, rootOid: string | null, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (rootOid === null) return out;
  const obj = objects.get(rootOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.bytes)) {
    const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') {
      for (const [k, v] of treeFlatten(objects, e.oid, p)) out.set(k, v);
    } else if (e.mode === '100644') {
      out.set(p, e.oid);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commits / tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(bytes: Buffer): CommitInfo {
  const text = bytes.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(bytes: Buffer): TagInfo {
  const text = bytes.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(info: TagInfo): Buffer {
  return Buffer.from(
    `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`,
    'utf8',
  );
}

/** Peel a ref to its commit: tag -> target (recursively), commit -> itself. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.bytes).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/** All objects reachable from `roots` (commits/tags/trees/blobs). */
/**
 * All objects reachable from `roots`. A commit in `boundaries` contributes
 * itself and its tree, but its parents are NOT walked: it is a shallow
 * boundary the other side has without its history (deepen fetches).
 */
export function collectReachable(objects: Map<string, GitObject>, roots: Iterable<string>, boundaries: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.bytes);
      stack.push(c.tree);
      if (!boundaries.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.bytes).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.bytes)) stack.push(e.oid);
    }
  }
  return seen;
}

/** Is `desc` a descendant of `anc` (or equal)? Walks first-parent and all parents. */
export function isDescendant(objects: Map<string, GitObject>, desc: string, anc: string): boolean {
  if (desc === anc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.bytes).parents) stack.push(p);
  }
  return false;
}

/** Commits reachable from `tip`, newest first (BFS by generation, parents after). */
export function walkCommits(objects: Map<string, GitObject>, tip: string | null): string[] {
  if (tip === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.bytes).parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles (version 2, plain objects, no deltas)
// ---------------------------------------------------------------------------

const PACK_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = PACK_TYPE_CODES[type];
  let s = size;
  const groups: number[] = [];
  groups.push(s & 0x0f);
  s >>= 4;
  while (s > 0) {
    groups.push(s & 0x7f);
    s >>= 7;
  }
  const out: number[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    let b = groups[i];
    if (i === 0) b |= code << 4;
    if (i < groups.length - 1) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

/** Serialize a set of objects as a packfile (deterministic order: sorted by oid). */
export function writePack(objects: Map<string, GitObject>, oids: Iterable<string>): Buffer {
  const list = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = objects.get(oid);
    if (!obj) continue;
    parts.push(packEntryHeader(obj.type, obj.bytes.length));
    parts.push(zlibDeflateSync(obj.bytes));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ParsedPack {
  objects: { oid: string; type: ObjType; bytes: Buffer }[];
}

/** Parse a packfile. Plain objects only; a delta entry is a hard error. */
export function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');
  const objects: ParsedPack['objects'] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= buf.length - 20) throw new Error('pack truncated');
    let b = buf[off];
    off += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_CODE_TYPES[typeCode];
    if (!type) throw new Error(`unsupported pack entry type ${typeCode}`);
    // Inflate from off; zlib inflateSync needs the exact stream — find its end by
    // trying inflate and measuring consumed bytes via a streaming Inflater.
    const { data, consumed } = inflateAt(buf, off);
    if (data.length !== size) throw new Error(`pack entry size mismatch: ${data.length} != ${size}`);
    off += consumed;
    const oid = hashObject(type, data);
    objects.push({ oid, type, bytes: data });
  }
  if (objects.length !== count) throw new Error('pack count mismatch');
  return { objects };
}

/** Inflate one zlib stream starting at `off`; returns data + bytes consumed.
 * inflateSync ignores trailing bytes and throws on truncation, so the exact
 * stream end is the smallest end offset that inflates cleanly (binary search). */
function inflateAt(buf: Buffer, off: number): { data: Buffer; consumed: number } {
  const limit = buf.length - 20; // trailer is the last 20 bytes
  let lo = off + 2; // at least the 2-byte zlib header
  let hi = limit;
  let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = zlibInflateSync(buf.subarray(off, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) data = zlibInflateSync(buf.subarray(off, lo));
  return { data, consumed: lo - off };
}
