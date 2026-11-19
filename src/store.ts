// The forge's single store. REST, GraphQL and MCP all read and write this.
// Git objects are the source of truth for file contents: a contents PUT builds
// a real commit on the branch tip, so git clone sees the same files.

import {
  ZERO_OID,
  type GitObject,
  type ObjType,
  hashObject,
  storeObject,
  parseTree,
  buildTree,
  treeSet,
  treeGet,
  treeList,
  treeFlatten,
  parseCommit,
  buildCommit,
  parseTag,
  peelToCommit,
  collectReachable,
  isDescendant,
  walkCommits,
} from './gitobj.ts';
import { EPOCH_SEC, VIEWER, DEFAULT_BRANCH, gid } from './util.ts';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  gid: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  gid: string;
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string; // base tip when the PR was created
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  files: PullFile[];
  gid: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref -> oid
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  numberSeq: number; // shared issues + PRs
  commitSeq: number; // deterministic commit timestamps
  commentSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPrId = 1;
  globalIds = new Map<string, { kind: string; owner: string; repo: string; number?: number }>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      numberSeq: 0,
      commitSeq: 0,
      commentSeq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(k, repo);
    this.globalIds.set(gid('R', `${owner}/${name}`), { kind: 'repo', owner, repo: name });
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------
  // Git objects / refs
  // -------------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
  }

  /** Commit bytes for a new commit on `parent` (null = root). Deterministic ts. */
  makeCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
  ): { oid: string; bytes: Buffer } {
    const ts = EPOCH_SEC + repo.commitSeq;
    repo.commitSeq += 1;
    const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    const bytes = buildCommit({
      tree: treeOid,
      parents,
      author: ident,
      committer: ident,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = storeObject(repo.objects, 'commit', bytes);
    return { oid, bytes };
  }

  /** Current tree oid of a branch tip (null when unborn). */
  branchTree(repo: Repo, branch: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.bytes).tree;
  }

  /**
   * Apply a contents write (PUT) or delete (DELETE) on `branch`, creating a
   * commit. Returns the new commit oid, or null if the branch does not exist
   * and this is not the first commit (unborn repo accepts the first commit).
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; blobOid: string | null } {
    const tip = this.branchTip(repo, branch);
    const baseTree = tip === null ? null : this.branchTree(repo, branch);
    let blobOid: string | null = null;
    let newTree: string;
    if (content === null) {
      newTree = treeSet(repo.objects, baseTree, path, null);
    } else {
      blobOid = storeObject(repo.objects, 'blob', content);
      newTree = treeSet(repo.objects, baseTree, path, { mode: '100644', oid: blobOid });
    }
    const parents = tip === null ? [] : [tip];
    const { oid } = this.makeCommit(repo, newTree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return { commitOid: oid, blobOid };
  }

  /** Read a file's bytes at a ref (branch name or commit oid). */
  readFileAt(repo: Repo, ref: string, path: string): { bytes: Buffer; blobOid: string } | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return null;
    const tree = parseCommit(obj.bytes).tree;
    const blobOid = treeGet(repo.objects, tree, path);
    if (blobOid === null) return null;
    const blob = repo.objects.get(blobOid);
    if (!blob || blob.type !== 'blob') return null;
    return { bytes: blob.bytes, blobOid };
  }

  /** List a directory at a ref. */
  listDirAt(
    repo: Repo,
    ref: string,
    path: string,
  ): { name: string; path: string; mode: string; oid: string }[] | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return null;
    return treeList(repo.objects, parseCommit(obj.bytes).tree, path);
  }

  /** Resolve a branch name, full ref, or commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (!oid) return null;
      return peelToCommit(repo.objects, oid);
    }
    if (repo.refs.has(`refs/heads/${ref}`)) {
      const oid = repo.refs.get(`refs/heads/${ref}`) as string;
      return peelToCommit(repo.objects, oid);
    }
    if (repo.refs.has(`refs/tags/${ref}`)) {
      const oid = repo.refs.get(`refs/tags/${ref}`) as string;
      return peelToCommit(repo.objects, oid);
    }
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
    if (obj && obj.type === 'tag') return peelToCommit(repo.objects, ref);
    return null;
  }

  /** Commits reachable from a ref, newest first. */
  commitsAt(repo: Repo, ref: string): { sha: string; message: string }[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    return walkCommits(repo.objects, tip).map((oid) => {
      const obj = repo.objects.get(oid) as GitObject;
      // The stored commit object ends with '\n' (git convention); the REST
      // surface reports the message as the caller wrote it.
      const raw = parseCommit(obj.bytes).message;
      return { sha: oid, message: raw.endsWith('\n') ? raw.slice(0, -1) : raw };
    });
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.numberSeq += 1;
    const number = repo.numberSeq;
    const issue: Issue = {
      id: this.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      gid: gid('I', `${repo.owner}/${repo.name}#${number}`),
      seq: repo.numberSeq,
    };
    this.nextIssueId += 1;
    repo.issues.push(issue);
    this.globalIds.set(issue.gid, { kind: 'issue', owner: repo.owner, repo: repo.name, number });
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    repo.commentSeq += 1;
    const comment: IssueComment = {
      id: repo.commentSeq,
      body,
      gid: gid('C', `${repo.owner}/${repo.name}#${issue.number}:${repo.commentSeq}`),
    };
    issue.comments.push(comment);
    this.globalIds.set(comment.gid, { kind: 'comment', owner: repo.owner, repo: repo.name, number: issue.number });
    return comment;
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  /** Diff two trees: path -> {status, oldOid, newOid}. */
  diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
    const base = treeFlatten(repo.objects, baseTree);
    const head = treeFlatten(repo.objects, headTree);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const p of [...paths].sort()) {
      const b = base.get(p);
      const h = head.get(p);
      if (b === h) continue;
      if (b === undefined && h !== undefined) {
        const bytes = repo.objects.get(h)?.bytes ?? Buffer.alloc(0);
        const lines = countLines(bytes);
        files.push({ filename: p, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b !== undefined && h === undefined) {
        const bytes = repo.objects.get(b)?.bytes ?? Buffer.alloc(0);
        const lines = countLines(bytes);
        files.push({ filename: p, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else {
        const nb = repo.objects.get(h as string)?.bytes ?? Buffer.alloc(0);
        const ob = repo.objects.get(b as string)?.bytes ?? Buffer.alloc(0);
        const [add, del] = diffLines(ob, nb);
        files.push({ filename: p, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return files;
  }

  createPullRequest(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    repo.numberSeq += 1;
    const number = repo.numberSeq;
    const headTip = peelToCommit(repo.objects, headSha) as string;
    const baseTip = peelToCommit(repo.objects, baseSha) as string;
    const headTree = parseCommit((repo.objects.get(headTip) as GitObject).bytes).tree;
    const baseTree = parseCommit((repo.objects.get(baseTip) as GitObject).bytes).tree;
    const pr: PullRequest = {
      id: this.nextPrId,
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
      files: this.diffTrees(repo, baseTree, headTree),
      gid: gid('P', `${repo.owner}/${repo.name}#${number}`),
      seq: repo.numberSeq,
    };
    this.nextPrId += 1;
    repo.pulls.push(pr);
    this.globalIds.set(pr.gid, { kind: 'pr', owner: repo.owner, repo: repo.name, number });
    return pr;
  }

  /**
   * Squash-merge a PR. Returns {ok} or {ok:false, reason}.
   * Conflict: a path changed on the head side since the PR's base AND changed
   * on the base side since then, with different resulting bytes.
   */
  mergePullRequest(repo: Repo, pr: PullRequest): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pr.state !== 'open') return { ok: false, reason: 'pull request is closed' };
    const baseTip = this.branchTip(repo, pr.baseRef);
    const headTip = this.branchTip(repo, pr.headRef);
    if (baseTip === null || headTip === null) return { ok: false, reason: 'branch not found' };
    const baseCommit = peelToCommit(repo.objects, baseTip) as string;
    const headCommit = peelToCommit(repo.objects, headTip) as string;
    const baseTree = parseCommit((repo.objects.get(baseCommit) as GitObject).bytes).tree;
    const headTree = parseCommit((repo.objects.get(headCommit) as GitObject).bytes).tree;
    const prBaseTree = parseCommit((repo.objects.get(pr.baseSha) as GitObject).bytes).tree;
    const headChanges = treeFlatten(repo.objects, headTree);
    const prBaseFiles = treeFlatten(repo.objects, prBaseTree);
    const curBaseFiles = treeFlatten(repo.objects, baseTree);
    // Conflict detection on paths the head changed vs the PR's base.
    const changedByHead = new Set<string>();
    for (const [p, oid] of headChanges) {
      if (prBaseFiles.get(p) !== oid) changedByHead.add(p);
    }
    for (const p of prBaseFiles.keys()) {
      if (!headChanges.has(p)) changedByHead.add(p);
    }
    for (const p of changedByHead) {
      const baseThen = prBaseFiles.get(p);
      const baseNow = curBaseFiles.get(p);
      const headNow = headChanges.get(p);
      if (baseThen !== baseNow && baseNow !== headNow && baseThen !== headNow) {
        return { ok: false, reason: 'merge conflict' };
      }
    }
    // Apply head's changes onto the current base tree.
    let newTree = baseTree;
    for (const p of changedByHead) {
      const headNow = headChanges.get(p);
      if (headNow === undefined) {
        newTree = treeSet(repo.objects, newTree, p, null);
      } else {
        newTree = treeSet(repo.objects, newTree, p, { mode: '100644', oid: headNow });
      }
    }
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`;
    const { oid } = this.makeCommit(repo, newTree, [baseCommit], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, oid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = '2025-01-01T00:00:00Z';
    pr.mergeCommitSha = oid;
    return { ok: true, sha: oid };
  }
}

export function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a) n += 1;
  if (bytes[bytes.length - 1] !== 0x0a) n += 1;
  return n;
}

/** Naive line diff: lines in `next` not in `prev` (additions), and vice versa. */
export function diffLines(prev: Buffer, next: Buffer): [number, number] {
  const a = new Set(prev.toString('utf8').split('\n'));
  const b = new Set(next.toString('utf8').split('\n'));
  let add = 0;
  let del = 0;
  for (const line of b) if (!a.has(line)) add += 1;
  for (const line of a) if (!b.has(line)) del += 1;
  return [add, del];
}

export { ZERO_OID, parseTree, buildTree, parseCommit, parseTag, peelToCommit, collectReachable, isDescendant, hashObject, storeObject };
export type { ObjType, GitObject };
