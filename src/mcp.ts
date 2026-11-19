// MCP over streamable HTTP (JSON-RPC 2.0): modern server/discover era
// (revision 2026-07-28) with a legacy initialize fallback. Six tools, all
// acting on the same store as REST. Single JSON responses (no SSE needed).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authOk, sendJson, sendErr, parseJson, readBody, VIEWER } from './util.ts';
import type { Store } from './store.ts';

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login' },
      },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolTextResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (req.method !== 'POST') {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const parsed = parseJson(body);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const v = parsed.value as Record<string, unknown>;
  const id = v.id as unknown;
  const method = typeof v.method === 'string' ? v.method : '';
  const params = (v.params ?? {}) as Record<string, unknown>;

  // Notifications (no id): accept silently.
  if (id === undefined) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    }));
    return;
  }

  if (method === 'initialize') {
    const offered = (params.protocolVersion as string) ?? '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, toolListResult()));
    return;
  }

  if (method === 'tools/call') {
    // Auth is decided before tool existence.
    if (!authOk(req)) {
      sendErr(res, 401, 'Requires authentication');
      return;
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      sendJson(res, 200, rpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    const missing = missingArgs(tool, args);
    if (missing.length > 0) {
      sendJson(res, 200, rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`));
      return;
    }
    const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
    const repoName = typeof args.repo === 'string' ? args.repo : '';
    const result = callTool(store, tool.name, owner, repoName, args);
    if (result === null) {
      sendJson(res, 200, rpcResult(id, toolErrorResult('Repository not found')));
      return;
    }
    sendJson(res, 200, rpcResult(id, toolTextResult(result)));
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}

function callTool(
  store: Store,
  name: string,
  owner: string,
  repoName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const existing = store.getRepo(owner, repoNameArg);
    const repo = existing ?? store.createRepo(owner, repoNameArg, { description, private: isPrivate });
    if (!repo) return { error: 'Repository already exists' };
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
  }

  const repo = store.getRepo(owner, repoName);
  if (!repo) return null;

  if (name === 'get_repo') {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    };
  }

  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    return {
      issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })),
    };
  }

  if (name === 'create_pull_request') {
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    const pr = store.createPullRequest(repo, title, body, head, base);
    if (!pr) return { error: 'Could not create pull request' };
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      head: { ref: pr.headRef, sha: pr.headSha },
      base: { ref: pr.baseRef, sha: pr.baseSha },
    };
  }

  if (name === 'merge_pull_request') {
    const n = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
    const pr = repo.pulls.find((p) => p.number === n);
    if (!pr) return { error: 'Pull request not found' };
    const result = store.mergePullRequest(repo, pr);
    if (!result.ok) return { error: result.reason, merged: false, number: pr.number };
    return { merged: true, number: pr.number, state: 'closed', sha: result.sha };
  }

  return { error: `Unknown tool: ${name}` };
}
