// GraphQL v4: the exact documents gh and github-mcp-server send.
// A small executor keyed on the operation name in each document (the suite
// sends 18 fixed documents, plus batched arrays of them).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authOk, sendJson, sendErr, parseJson, readBody, b64urlEncode, VIEWER } from './util.ts';
import type { Store, Repo } from './store.ts';

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'headRefOid', 'baseRefOid', 'url', 'createdAt', 'updatedAt', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MARKETPLACE', 'MILESTONE', 'TOPIC'];

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function repoGid(repo: Repo): string {
  return b64urlEncode(`R:${repo.owner}/${repo.name}`);
}

function issueNode(repo: Repo, issue: { id: number; number: number; title: string; state: string; body: string; gid: string }): Record<string, unknown> {
  return { id: issue.gid, number: issue.number, title: issue.title, state: issue.state.toUpperCase(), body: issue.body };
}

function prNode(pr: { id: number; number: number; state: string; merged: boolean; headRef: string; baseRef: string; gid: string }): Record<string, unknown> {
  return {
    id: pr.gid,
    number: pr.number,
    state: pr.state.toUpperCase(),
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    mergeable: 'MERGEABLE',
  };
}

function opName(query: string): string {
  const m = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return m ? m[1] : '';
}

function cursorFor(number: number): string {
  return b64urlEncode(`cur:${number}`);
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cur:(\d+)$/.exec(text);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

type GqlResult = { data: Record<string, unknown> | null; errors?: { message: string }[] };

function executeOne(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  const op = opName(query);
  const vars = variables ?? {};

  // Introspection by operation name.
  if (op === 'Issue_fields') {
    return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } } };
  }
  if (op === 'PullRequestAndRepositoryFields') {
    return {
      data: {
        PullRequest: { fields: PR_FIELDS.map((name) => ({ name })) },
        Repository: { fields: REPO_FIELDS.map((name) => ({ name })) },
      },
    };
  }
  if (op === 'SearchType_enumValues') {
    return { data: { SearchType: { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) } } };
  }
  // Generic __type fallback (any other introspection shape).
  if (query.includes('__type')) {
    const nameMatch = /__type\s*\(\s*name:\s*"([^"]+)"/.exec(query);
    const typeName = nameMatch ? nameMatch[1] : '';
    const fields =
      typeName === 'Issue' ? ISSUE_FIELDS : typeName === 'PullRequest' ? PR_FIELDS : typeName === 'Repository' ? REPO_FIELDS : [];
    const data: Record<string, unknown> = {};
    // Aliases: the query may alias __type as e.g. `Issue:` — keep the alias key.
    const aliasMatch = /(\w+)\s*:\s*__type/.exec(query);
    const key = aliasMatch ? aliasMatch[1] : '__type';
    if (typeName === 'SearchType') {
      data[key] = { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) };
    } else {
      data[key] = { fields: fields.map((name) => ({ name })) };
    }
    return { data };
  }

  if (op === 'ViewerLogin') {
    return { data: { viewer: { login: VIEWER.login } } };
  }

  if (op === 'ViewerInvalidField' || query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: null },
      errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'" }],
    };
  }

  // Repository-scoped queries.
  const owner = typeof vars.owner === 'string' ? vars.owner : '';
  const name = typeof vars.name === 'string' ? vars.name : '';
  const repo = owner !== '' && name !== '' ? store.getRepo(owner, name) : undefined;

  if (op === 'RepositoryFields') {
    if (!repo) return { data: { repository: null } };
    return { data: { repository: repoNode(repo) } };
  }

  if (op === 'NodeRepository') {
    const id = typeof vars.id === 'string' ? vars.id : '';
    const target = store.globalIds.get(id);
    if (!target || target.kind !== 'repo') return { data: { node: null } };
    const r = store.getRepo(target.owner, target.repo);
    if (!r) return { data: { node: null } };
    return { data: { node: { id, name: r.name, nameWithOwner: `${r.owner}/${r.name}` } } };
  }

  if (op === 'OpenIssues' || op === 'IssuesPage') {
    if (!repo) return { data: { repository: null } };
    const first = typeof vars.first === 'number' ? vars.first : 10;
    const after = typeof vars.after === 'string' ? vars.after : null;
    // Inline states filter from the query text, e.g. states: [OPEN].
    const statesMatch = /states:\s*\[([^\]]*)\]/.exec(query);
    const onlyOpen = statesMatch ? statesMatch[1].includes('OPEN') : false;
    let issues = [...repo.issues];
    if (onlyOpen) issues = issues.filter((i) => i.state === 'open');
    // CREATED_AT DESC == number DESC (numbers increase with creation).
    issues.sort((a, b) => b.number - a.number);
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) issues = issues.filter((i) => i.number < afterNumber);
    const page = issues.slice(0, first);
    const hasNext = issues.length > first;
    const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : '';
    return {
      data: {
        repository: {
          issues: {
            nodes: page.map((i) => issueNode(repo, i)),
            pageInfo: { hasNextPage: hasNext, endCursor },
          },
        },
      },
    };
  }

  if (op === 'IssueByNumber') {
    if (!repo) return { data: { repository: null } };
    const number = typeof vars.number === 'number' ? vars.number : 0;
    const issue = repo.issues.find((i) => i.number === number);
    return { data: { repository: { issue: issue ? issueNode(repo, issue) : null } } };
  }

  if (op === 'PullRequests') {
    if (!repo) return { data: { repository: null } };
    const first = typeof vars.first === 'number' ? vars.first : 10;
    const nodes = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first).map((p) => prNode(p));
    return { data: { repository: { pullRequests: { nodes } } } };
  }

  if (op === 'PullRequestFiles') {
    if (!repo) return { data: { repository: null } };
    const number = typeof vars.number === 'number' ? vars.number : 0;
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) return { data: { repository: { pullRequest: null } } };
    return {
      data: {
        repository: {
          pullRequest: {
            number: pr.number,
            files: { nodes: pr.files.map((f) => ({ path: f.filename })) },
          },
        },
      },
    };
  }

  if (op === 'PullRequestId') {
    if (!repo) return { data: { repository: null } };
    const number = typeof vars.number === 'number' ? vars.number : 0;
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) return { data: { repository: { pullRequest: null } } };
    return { data: { repository: { pullRequest: { id: pr.gid, number: pr.number } } } };
  }

  // Mutations.
  if (op === 'IssueCreate') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const target = store.globalIds.get(repoId);
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (!target || target.kind !== 'repo') {
      return { data: { createIssue: null }, errors: [{ message: 'Could not resolve to a Repository with the global id.' }] };
    }
    const r = store.getRepo(target.owner, target.repo);
    if (!r) {
      return { data: { createIssue: null }, errors: [{ message: 'Could not resolve to a Repository with the global id.' }] };
    }
    const issue = store.createIssue(r, title, body, []);
    return { data: { createIssue: { issue: { number: issue.number, id: issue.gid } } } };
  }

  if (op === 'IssueClose') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const issueId = typeof input.issueId === 'string' ? input.issueId : '';
    const target = store.globalIds.get(issueId);
    if (!target || target.kind !== 'issue') {
      return { data: { closeIssue: null }, errors: [{ message: 'Could not resolve to an Issue with the global id.' }] };
    }
    const r = store.getRepo(target.owner, target.repo);
    const issue = r?.issues.find((i) => i.number === target.number);
    if (!issue) {
      return { data: { closeIssue: null }, errors: [{ message: 'Could not resolve to an Issue with the global id.' }] };
    }
    issue.state = 'closed';
    return { data: { closeIssue: { issue: { number: issue.number, id: issue.gid, state: 'CLOSED' } } } };
  }

  if (op === 'PullRequestCreate') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const target = store.globalIds.get(repoId);
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const title = typeof input.title === 'string' ? input.title : '';
    if (!target || target.kind !== 'repo') {
      return { data: { createPullRequest: null }, errors: [{ message: 'Could not resolve to a Repository with the global id.' }] };
    }
    const r = store.getRepo(target.owner, target.repo);
    if (!r) {
      return { data: { createPullRequest: null }, errors: [{ message: 'Could not resolve to a Repository with the global id.' }] };
    }
    const pr = store.createPullRequest(r, title, '', headRefName, baseRefName);
    if (!pr) {
      return { data: { createPullRequest: null }, errors: [{ message: 'Validation Failed' }] };
    }
    return {
      data: {
        createPullRequest: {
          pullRequest: { number: pr.number, id: pr.gid, state: 'OPEN', headRefName: pr.headRef, baseRefName: pr.baseRef },
        },
      },
    };
  }

  if (op === 'MergePullRequest') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
    const target = store.globalIds.get(prId);
    if (!target || target.kind !== 'pr') {
      return { data: { mergePullRequest: null }, errors: [{ message: 'Could not resolve to a PullRequest with the global id.' }] };
    }
    const r = store.getRepo(target.owner, target.repo);
    const pr = r?.pulls.find((p) => p.number === target.number);
    if (!pr || !r) {
      return { data: { mergePullRequest: null }, errors: [{ message: 'Could not resolve to a PullRequest with the global id.' }] };
    }
    const result = store.mergePullRequest(r, pr);
    if (!result.ok) {
      return {
        data: { mergePullRequest: { pullRequest: { number: pr.number, merged: false, state: 'OPEN' } } },
        errors: [{ message: result.reason }],
      };
    }
    return { data: { mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'CLOSED' } } } };
  }

  if (op === 'AddComment') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const target = store.globalIds.get(subjectId);
    if (!target || target.kind !== 'issue') {
      return { data: { addComment: null }, errors: [{ message: 'Could not resolve to an Issue with the global id.' }] };
    }
    const r = store.getRepo(target.owner, target.repo);
    const issue = r?.issues.find((i) => i.number === target.number);
    if (!issue || !r) {
      return { data: { addComment: null }, errors: [{ message: 'Could not resolve to an Issue with the global id.' }] };
    }
    const comment = store.addComment(r, issue, body);
    return { data: { addComment: { commentEdge: { node: { id: comment.gid, body: comment.body } } } } };
  }

  // Unknown document: GraphQL-style error, HTTP 200.
  return { data: null, errors: [{ message: `Cannot query field '${op || 'unknown'}'` }] };
}

export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendErr(res, 404, 'Not Found');
    return;
  }
  if (!authOk(req)) {
    sendErr(res, 401, 'Requires authentication');
    return;
  }
  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 400, { errors: [{ message: 'Request body too large' }] });
    return;
  }
  const parsed = parseJson(body);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    const results = value.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid operation' }] };
      const e = entry as Record<string, unknown>;
      const query = typeof e.query === 'string' ? e.query : '';
      const variables = (e.variables ?? {}) as Record<string, unknown>;
      return executeOne(store, query, variables);
    });
    sendJson(res, 200, results);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    sendJson(res, 400, { errors: [{ message: 'Invalid operation' }] });
    return;
  }
  const v = value as Record<string, unknown>;
  const query = typeof v.query === 'string' ? v.query : '';
  const variables = (v.variables ?? {}) as Record<string, unknown>;
  sendJson(res, 200, executeOne(store, query, variables));
}
