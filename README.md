# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/winah1308-hub/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/winah1308-hub/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in pure Node 22 standard library: smart-HTTP git (clone/push, shallow/deepen, annotated tags, ls-refs), REST v3 (repos, branches, commits, contents, issues, pull requests), GraphQL (the `gh` CLI and github-mcp-server shapes), and MCP tools — all in one process, with no dependencies, no git binary, and no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port of its own, registers it with the suite via `POST $MAKEFUN_ENV_URL/register`, serves from its own in-memory store, and exits when `GET $MAKEFUN_ENV_URL/done` reports `{"done": true}`. Requires Node 22+ (`--experimental-strip-types` for the TypeScript sources).

## Layout

- `main.ts` — lifecycle: bind, register, poll for done, exit.
- `app.ts` — HTTP router (`/healthz`, `/mcp`, `/api/graphql`, `/api/v3/*`, `/*.git/*`).
- `src/gitobj.ts` — SHA-1 objects, trees/commits/tags, packfiles (plain objects, zlib).
- `src/gitproto.ts` — pkt-line framing, protocol v2 upload-pack (ls-refs/fetch), v0 fetch, v0 receive-pack with report-status.
- `src/store.ts` — in-memory store: repos, refs, issues, pull requests, labels, comments.
- `src/rest.ts` — GitHub REST v3 surface.
- `src/graphql.ts` — GraphQL executor for the 18 fixed documents.
- `src/mcp.ts` — MCP streamable HTTP: `server/discover`, `initialize`, 6 tools.
- `src/util.ts` — fixed scenario timestamps, auth, pagination, request ids.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
