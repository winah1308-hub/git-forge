// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, merges. All JSON, X-GitHub-Request-Id on every
// reply, Bearer auth (missing/wrong -> 401), foreign owner -> 404 never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authOk,
  sendJson,
  sendErr,
  queryOf,
  parseJson,
  readBody,
  pageParams,
  paginate,
  linkHeader,
  nextRequestId,
  VIEWER,
  FIXED_TS,
} from './util.ts';
import type { Store, Repo, Issue, PullRequest } from './store.ts';

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function prJson(pr: PullRequest, repo: Repo): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged ? pr.mergedAt : null,
    merge_commit_sha: pr.merged ? pr.mergeCommitSha : null,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  };
}

function branchJson(repo: Repo, branch: string): Record<string, unknown> | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return null;
  return { name: branch, commit: { sha: tip }, protected: false };
}

export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);

  // API root / meta / user — no repo needed.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    if (!authOk(req)) {
      sendErr(res, 401, 'Requires authentication');
      return;
    }
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }

  // All other /api/v3 routes require auth.
  if (!authOk(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }

  // POST /user/repos — create a repo for the viewer.
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const body = await readBody(req);
    if (body === null) {
      sendErr(res, 400, 'Bad Request');
      return;
    }
    const parsed = parseJson(body);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      sendErr(res, 400, 'Problems parsing JSON');
      return;
    }
    const v = parsed.value as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name : '';
    if (name === '') {
      sendErr(res, 422, 'Validation Failed');
      return;
    }
    const repo = store.createRepo(VIEWER.login, name, {
      description: typeof v.description === 'string' ? v.description : '',
      private: v.private === true,
    });
    if (repo === null) {
      sendErr(res, 422, 'Repository already exists');
      return;
    }
    sendJson(res, 201, repoJson(repo));
    return;
  }

  // GET /user/repos — paginated list of the viewer's repos.
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const { page, perPage } = pageParams(q);
    const all = store.listViewerRepos();
    const link = linkHeader(req, '/api/v3/user/repos', page, perPage, all.length);
    sendJson(res, 200, paginate(all, page, perPage).map(repoJson), link ? { link } : {});
    return;
  }

  // /repos/{owner}/{repo}[...]
  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const [, owner, repoName, rest] = m;
  const repo = store.getRepo(owner, repoName);
  if (!repo || owner !== VIEWER.login) {
    // Foreign owner or missing repo: 404, never 403.
    sendErr(res, 404, 'Not Found');
    return;
  }
  const sub = rest ?? '';

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (sub === '') {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (body === null) {
        sendErr(res, 400, 'Bad Request');
        return;
      }
      const parsed = parseJson(body);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
        sendErr(res, 400, 'Problems parsing JSON');
        return;
      }
      const v = parsed.value as Record<string, unknown>;
      if (typeof v.description === 'string') repo.description = v.description;
      if (typeof v.private === 'boolean') repo.private = v.private;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  // POST /git/refs — create a ref.
  if (sub === 'git/refs' && method === 'POST') {
    const body = await readBody(req);
    if (body === null) {
      sendErr(res, 400, 'Bad Request');
      return;
    }
    const parsed = parseJson(body);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      sendErr(res, 400, 'Problems parsing JSON');
      return;
    }
    const v = parsed.value as Record<string, unknown>;
    const ref = typeof v.ref === 'string' ? v.ref : '';
    const sha = typeof v.sha === 'string' ? v.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha)) {
      sendErr(res, 422, 'Validation Failed');
      return;
    }
    if (repo.refs.has(ref)) {
      sendErr(res, 422, 'Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    return;
  }

  // GET /git/refs/heads/{branch} — single ref.
  const singleRef = /^git\/refs\/heads\/(.+)$/.exec(sub);
  if (singleRef && method === 'GET') {
    const branch = decodeURIComponent(singleRef[1]);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
    return;
  }

  // GET /branches — list all branches.
  if (sub === 'branches' && method === 'GET') {
    const branches: Record<string, unknown>[] = [];
    for (const ref of [...repo.refs.keys()].sort()) {
      if (ref.startsWith('refs/heads/')) {
        const b = branchJson(repo, ref.slice('refs/heads/'.length));
        if (b) branches.push(b);
      }
    }
    sendJson(res, 200, branches);
    return;
  }

  // GET /branches/{branch} — single branch.
  const singleBranch = /^branches\/(.+)$/.exec(sub);
  if (singleBranch && method === 'GET') {
    const b = branchJson(repo, decodeURIComponent(singleBranch[1]));
    if (!b) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, b);
    return;
  }

  // GET /commits[?sha=]
  if (sub === 'commits' && method === 'GET') {
    const ref = q.get('sha') ?? repo.defaultBranch;
    const list = store.commitsAt(repo, ref);
    sendJson(res, 200, list.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
    return;
  }

  // contents/{path...}
  if (sub.startsWith('contents')) {
    await handleContents(store, repo, req, res, method, q, sub.slice('contents'.length));
    return;
  }

  // POST /labels
  if (sub === 'labels' && method === 'POST') {
    const body = await readBody(req);
    if (body === null) {
      sendErr(res, 400, 'Bad Request');
      return;
    }
    const parsed = parseJson(body);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      sendErr(res, 400, 'Problems parsing JSON');
      return;
    }
    const v = parsed.value as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name : '';
    if (name === '') {
      sendErr(res, 422, 'Validation Failed');
      return;
    }
    const color = typeof v.color === 'string' ? v.color : 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color });
    return;
  }
  if (sub === 'labels' && method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()]);
    return;
  }

  // issues...
  if (sub === 'issues' || sub.startsWith('issues/')) {
    await handleIssues(store, repo, req, res, method, q, sub);
    return;
  }

  // pulls...
  if (sub === 'pulls' || sub.startsWith('pulls/')) {
    await handlePulls(store, repo, req, res, method, q, sub);
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function handleContents(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  q: URLSearchParams,
  rest: string,
): Promise<void> {
  // rest is like '/docs/readme.md' or '' (root).
  const rawPath = rest.startsWith('/') ? rest.slice(1) : rest;
  const filePath = decodeURIComponent(rawPath);
  const ref = q.get('ref') ?? repo.defaultBranch;

  if (method === 'GET') {
    if (filePath === '') {
      const entries = store.listDirAt(repo, ref, '');
      if (entries === null) {
        sendErr(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, entries.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.path,
        sha: e.oid,
      })));
      return;
    }
    const file = store.readFileAt(repo, ref, filePath);
    if (file) {
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: file.bytes.toString('base64'),
        sha: file.blobOid,
        size: file.bytes.length,
        name: filePath.split('/').pop(),
        path: filePath,
      });
      return;
    }
    const dir = store.listDirAt(repo, ref, filePath);
    if (dir !== null) {
      sendJson(res, 200, dir.map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.path,
        sha: e.oid,
      })));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = await readBody(req);
    if (body === null) {
      sendErr(res, 400, 'Bad Request');
      return;
    }
    const parsed = parseJson(body);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      sendErr(res, 400, 'Problems parsing JSON');
      return;
    }
    const v = parsed.value as Record<string, unknown>;
    const message = typeof v.message === 'string' ? v.message : 'update';
    const branch = typeof v.branch === 'string' ? v.branch : repo.defaultBranch;
    const sha = typeof v.sha === 'string' ? v.sha : undefined;
    if (method === 'PUT') {
      const contentB64 = typeof v.content === 'string' ? v.content : '';
      const content = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
      const existing = store.readFileAt(repo, branch, filePath);
      if (existing) {
        // Update: sha must match the current blob sha.
        if (sha === undefined || sha.toLowerCase() !== existing.blobOid.toLowerCase()) {
          sendErr(res, 409, 'sha does not match');
          return;
        }
        const { commitOid, blobOid } = store.commitFile(repo, branch, filePath, content, message);
        sendJson(res, 200, { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitOid } });
        return;
      }
      if (sha !== undefined) {
        sendErr(res, 409, 'sha does not match');
        return;
      }
      const { commitOid, blobOid } = store.commitFile(repo, branch, filePath, content, message);
      sendJson(res, 201, { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitOid } });
      return;
    }
    // DELETE
    const existing = store.readFileAt(repo, branch, filePath);
    if (!existing) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    if (sha === undefined || sha.toLowerCase() !== existing.blobOid.toLowerCase()) {
      sendErr(res, 409, 'sha does not match');
      return;
    }
    const { commitOid } = store.commitFile(repo, branch, filePath, null, message);
    sendJson(res, 200, { commit: { sha: commitOid } });
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function handleIssues(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  q: URLSearchParams,
  sub: string,
): Promise<void> {
  const { page, perPage } = pageParams(q);

  if (sub === 'issues' && method === 'POST') {
    const body = await readBody(req);
    if (body === null) {
      sendErr(res, 400, 'Bad Request');
      return;
    }
    const parsed = parseJson(body);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      sendErr(res, 400, 'Problems parsing JSON');
      return;
    }
    const v = parsed.value as Record<string, unknown>;
    const title = typeof v.title === 'string' ? v.title : '';
    const bodyText = typeof v.body === 'string' ? v.body : '';
    const labels = Array.isArray(v.labels) ? v.labels.filter((l): l is string => typeof l === 'string') : [];
    for (const l of labels) {
      if (!repo.labels.has(l)) {
        sendErr(res, 422, `Validation Failed: label "${l}" does not exist`);
        return;
      }
    }
    const issue = store.createIssue(repo, title, bodyText, labels);
    sendJson(res, 201, issueJson(issue, repo));
    return;
  }

  if (sub === 'issues' && method === 'GET') {
    const state = q.get('state') ?? 'open';
    const sort = q.get('sort') ?? 'created';
    const direction = q.get('direction') ?? 'desc';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    }
    const base = `/api/v3/repos/${repo.owner}/${repo.name}/issues`;
    const link = linkHeader(req, base, page, perPage, list.length);
    sendJson(res, 200, paginate(list, page, perPage).map((i) => issueJson(i, repo)), link ? { link } : {});
    return;
  }

  const one = /^issues\/(\d+)$/.exec(sub);
  if (one) {
    const n = Number.parseInt(one[1], 10);
    const issue = repo.issues.find((i) => i.number === n);
    if (!issue) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(issue, repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (body === null) {
        sendErr(res, 400, 'Bad Request');
        return;
      }
      const parsed = parseJson(body);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
        sendErr(res, 400, 'Problems parsing JSON');
        return;
      }
      const v = parsed.value as Record<string, unknown>;
      if (v.state === 'open' || v.state === 'closed') issue.state = v.state;
      if (typeof v.title === 'string') issue.title = v.title;
      if (typeof v.body === 'string') issue.body = v.body;
      sendJson(res, 200, issueJson(issue, repo));
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  const comments = /^issues\/(\d+)\/comments$/.exec(sub);
  if (comments) {
    const n = Number.parseInt(comments[1], 10);
    const issue = repo.issues.find((i) => i.number === n);
    if (!issue) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (body === null) {
        sendErr(res, 400, 'Bad Request');
        return;
      }
      const parsed = parseJson(body);
      if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
        sendErr(res, 400, 'Problems parsing JSON');
        return;
      }
      const v = parsed.value as Record<string, unknown>;
      const text = typeof v.body === 'string' ? v.body : '';
      const comment = store.addComment(repo, issue, text);
      sendJson(res, 201, { id: comment.id, body: comment.body });
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  sendErr(res, 404, 'Not Found');
}

async function handlePulls(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  q: URLSearchParams,
  sub: string,
): Promise<void> {
  const { page, perPage } = pageParams(q);

  if (sub === 'pulls' && method === 'POST') {
    const body = await readBody(req);
    if (body === null) {
      sendErr(res, 400, 'Bad Request');
      return;
    }
    const parsed = parseJson(body);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
      sendErr(res, 400, 'Problems parsing JSON');
      return;
    }
    const v = parsed.value as Record<string, unknown>;
    const title = typeof v.title === 'string' ? v.title : '';
    const bodyText = typeof v.body === 'string' ? v.body : '';
    const head = typeof v.head === 'string' ? v.head : '';
    const base = typeof v.base === 'string' ? v.base : repo.defaultBranch;
    const pr = store.createPullRequest(repo, title, bodyText, head, base);
    if (!pr) {
      sendErr(res, 422, 'Validation Failed');
      return;
    }
    sendJson(res, 201, prJson(pr, repo));
    return;
  }

  if (sub === 'pulls' && method === 'GET') {
    const state = q.get('state') ?? 'open';
    let list = [...repo.pulls];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const base = `/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
    const link = linkHeader(req, base, page, perPage, list.length);
    sendJson(res, 200, paginate(list, page, perPage).map((p) => prJson(p, repo)), link ? { link } : {});
    return;
  }

  const files = /^pulls\/(\d+)\/files$/.exec(sub);
  if (files && method === 'GET') {
    const n = Number.parseInt(files[1], 10);
    const pr = repo.pulls.find((p) => p.number === n);
    if (!pr) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, pr.files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    })));
    return;
  }

  const merge = /^pulls\/(\d+)\/merge$/.exec(sub);
  if (merge && method === 'PUT') {
    const n = Number.parseInt(merge[1], 10);
    const pr = repo.pulls.find((p) => p.number === n);
    if (!pr) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    // Drain the body (merge_method may be present).
    await readBody(req);
    const result = store.mergePullRequest(repo, pr);
    if (!result.ok) {
      sendErr(res, 405, result.reason);
      return;
    }
    sendJson(res, 200, { merged: true, sha: result.sha, message: `Pull request #${n} merged` });
    return;
  }

  const one = /^pulls\/(\d+)$/.exec(sub);
  if (one && method === 'GET') {
    const n = Number.parseInt(one[1], 10);
    const pr = repo.pulls.find((p) => p.number === n);
    if (!pr) {
      sendErr(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, prJson(pr, repo));
    return;
  }

  sendErr(res, 404, 'Not Found');
}
