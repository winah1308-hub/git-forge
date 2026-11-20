// Entry point: the trial harness talks to this process through one env var.
// MAKEFUN_ENV_URL is the origin of the trial environment. This process binds
// its own server to an ephemeral port, announces that port to the env, and
// then waits until the env reports the trial is finished. The grading suite
// exercises the HTTP server this entry builds (app.ts); this file only owns
// the handshake with the environment, so its behaviour must stay exactly
// this shape:
//
//   1. Read MAKEFUN_ENV_URL. With nothing set there is no environment to
//      talk to, so the process gives up immediately with exit code 1.
//   2. Start the server on port 0 and let the kernel choose a free port.
//      Port 8080 is the environment's own, never ours.
//   3. Tell the environment the chosen port with POST /register. The first
//      announcement wins; a 409 only means another entry already won it,
//      which is fine and not something this process can change.
//   4. Poll GET /done until the environment answers {"done": true}. The
//      answer comes back at once ("done": false while the suite is still
//      running), so this is a short poll loop, not a held-open request.
//   5. Shut the server down and exit 0. The harness stops the env after
//      that, and the env writes out what the scorer reads.
//
// main.ts only ever imports its own server. No third-party package, no
// Node built-in, no model call happens here.

import { createApp } from './app.ts';

/** Read the trial environment's origin, without a trailing slash. */
function envOrigin(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

/** Longest a single register or done request is allowed to run. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const RETRY_FIRST_MS = 250;
const RETRY_LONGEST_MS = 2_000;

/** Pause for `ms` milliseconds. */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait after the `attempt`-th failed request: it doubles from
 * RETRY_FIRST_MS and never passes RETRY_LONGEST_MS.
 */
function pauseAfter(attempt: number): number {
  return Math.min(RETRY_LONGEST_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the port this process bound until the environment accepts it. A 200
 * is the normal answer and a 409 means a first announcement already won,
 * both of which end the loop. A 400 or 405 is a contract error and ends
 * the process. Anything else (a network error, another status) is retried,
 * since the environment may still be starting up.
 */
async function announcePort(port: number, origin: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) {
        throw err;
      }
    }
    await pause(pauseAfter(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function awaitDone(origin: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the request timed out:
      // it is not done, so the loop polls again.
    }
    await pause(pauseAfter(attempt));
  }
}

/** Bind the port, announce it, then wait for the environment to finish. */
async function run(): Promise<void> {
  const origin = envOrigin();
  if (origin === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announcePort(address.port, origin);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone(origin);
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
