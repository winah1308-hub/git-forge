// The forge's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4,
// MCP — one process, one in-memory store, standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/gitproto.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { sendJson, pathOf, readBody } from './src/util.ts';

const store = new Store();

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(req, res);
      } catch (err) {
        // Never crash on a request; answer a JSON 500.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/mcp') {
    await handleMcp(store, req, res);
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphql(store, req, res);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(store, req, res, path);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs | git-upload-pack | git-receive-pack
  if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
    let body: Buffer | null = null;
    if (method === 'POST') {
      body = await readBody(req);
      if (body === null) {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
    }
    handleGit(store, req, res, path, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
