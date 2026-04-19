import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:net';
import { once } from 'node:events';
import { serve, request } from '../../src/supervisor/controlSocket.js';
import { socketPath } from '../../src/paths.js';

const VALID_PLAN_ID = 'p_2026-04-18_abcd';

let oldOaHome: string | undefined;
let tmpHome: string;
let servers: Server[] = [];

beforeEach(async () => {
  oldOaHome = process.env.OA_HOME;
  tmpHome = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-control-socket-'));
  process.env.OA_HOME = tmpHome;
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (oldOaHome === undefined) {
    delete process.env.OA_HOME;
  } else {
    process.env.OA_HOME = oldOaHome;
  }
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await once(server, 'listening');
}

describe('controlSocket', () => {
  it('serves stop and status requests over a real unix socket', async () => {
    const p = socketPath(VALID_PLAN_ID);
    const server = serve(p, {
      stop: async (msg) => ({
        schemaVersion: 1,
        type: 'stop.reply',
        acknowledged: true,
        now: msg.now,
      }),
      status: async () => ({
        schemaVersion: 1,
        type: 'status.reply',
        running: true,
      }),
    });
    servers.push(server);
    await waitForListening(server);

    const statusReply = await request(p, { schemaVersion: 1, type: 'status' });
    expect(statusReply).toMatchObject({
      schemaVersion: 1,
      type: 'status.reply',
      running: true,
    });

    const stopReply = await request(p, { schemaVersion: 1, type: 'stop', now: false });
    expect(stopReply).toMatchObject({
      schemaVersion: 1,
      type: 'stop.reply',
      acknowledged: true,
      now: false,
    });
  });

  it('unlinks a stale socket file before binding', async () => {
    const p = socketPath(VALID_PLAN_ID);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, 'stale socket placeholder', 'utf8');

    const server = serve(p, {
      stop: async (msg) => ({
        schemaVersion: 1,
        type: 'stop.reply',
        acknowledged: true,
        now: msg.now,
      }),
      status: async () => ({
        schemaVersion: 1,
        type: 'status.reply',
        running: false,
      }),
    });
    servers.push(server);
    await waitForListening(server);

    const reply = await request(p, { schemaVersion: 1, type: 'status' });
    expect(reply).toMatchObject({
      schemaVersion: 1,
      type: 'status.reply',
      running: false,
    });
  });

  it('removes the socket file when the server closes', async () => {
    const p = socketPath(VALID_PLAN_ID);
    const server = serve(p, {
      stop: async () => ({
        schemaVersion: 1,
        type: 'stop.reply',
        acknowledged: true,
      }),
      status: async () => ({
        schemaVersion: 1,
        type: 'status.reply',
        running: true,
      }),
    });
    servers.push(server);
    await waitForListening(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers = servers.filter((s) => s !== server);

    await expect(fs.access(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not steal the path from an already-live socket server', async () => {
    const p = socketPath(VALID_PLAN_ID);
    const first = serve(p, {
      stop: async () => ({
        schemaVersion: 1,
        type: 'stop.reply',
        owner: 'first',
      }),
      status: async () => ({
        schemaVersion: 1,
        type: 'status.reply',
        owner: 'first',
      }),
    });
    servers.push(first);
    await waitForListening(first);

    const second = serve(p, {
      stop: async () => ({
        schemaVersion: 1,
        type: 'stop.reply',
        owner: 'second',
      }),
      status: async () => ({
        schemaVersion: 1,
        type: 'status.reply',
        owner: 'second',
      }),
    });

    const [err] = (await once(second, 'error')) as [NodeJS.ErrnoException];
    expect(err.code).toBe('EADDRINUSE');

    const reply = await request(p, { schemaVersion: 1, type: 'status' });
    expect(reply).toMatchObject({
      schemaVersion: 1,
      type: 'status.reply',
      owner: 'first',
    });
  });
});
