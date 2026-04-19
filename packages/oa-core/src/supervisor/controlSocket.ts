import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { z } from 'zod';
import { assertAbs } from '../paths.js';

const SCHEMA_VERSION = 1 as const;
const FRAME_BYTES = 4;

const BaseMessageSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
});

const StopRequestSchema = BaseMessageSchema.extend({
  type: z.literal('stop'),
  now: z.boolean(),
});

const StatusRequestSchema = BaseMessageSchema.extend({
  type: z.literal('status'),
});

const RequestSchema = z.discriminatedUnion('type', [
  StopRequestSchema,
  StatusRequestSchema,
]);

const ReplySchema = BaseMessageSchema.passthrough();

export type StopRequest = z.infer<typeof StopRequestSchema>;
export type StatusRequest = z.infer<typeof StatusRequestSchema>;
export type ControlRequest = z.infer<typeof RequestSchema>;
export type ControlReply = z.infer<typeof ReplySchema>;

export interface ControlHandlers {
  stop: (message: StopRequest) => Promise<ControlReply> | ControlReply;
  status: (message: StatusRequest) => Promise<ControlReply> | ControlReply;
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(FRAME_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer: Buffer): { body: Buffer; rest: Buffer } | null {
  if (buffer.length < FRAME_BYTES) return null;
  const size = buffer.readUInt32BE(0);
  if (buffer.length < FRAME_BYTES + size) return null;
  return {
    body: buffer.subarray(FRAME_BYTES, FRAME_BYTES + size),
    rest: buffer.subarray(FRAME_BYTES + size),
  };
}

function normalizeReply(reply: unknown): ControlReply {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('control socket reply must be a JSON object');
  }
  const normalized = { schemaVersion: SCHEMA_VERSION, ...(reply as Record<string, unknown>) };
  return ReplySchema.parse(normalized);
}

function encodeError(message: string): Buffer {
  return encodeFrame({
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    error: message,
  });
}

function parseRequest(raw: Buffer): ControlRequest {
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  return RequestSchema.parse(parsed);
}

function unlinkIfPresent(absPath: string): void {
  try {
    fs.unlinkSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function closeOnFinished(socket: net.Socket, payload: Buffer): void {
  socket.end(payload);
}

/**
 * Control socket server for the supervisor daemon.
 *
 * The server accepts one length-prefixed JSON message per connection, dispatches
 * by `type`, writes one JSON reply, then closes the connection. The socket path
 * is unlinked before bind so a stale leftover file does not block startup, and
 * it is removed again when the server closes.
 */
export function serve(absPath: string, handlers: ControlHandlers): net.Server {
  assertAbs(absPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  unlinkIfPresent(absPath);

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handled = false;

    const finish = async (): Promise<void> => {
      if (handled) return;
      const frame = decodeFrame(buffer);
      if (frame === null) return;
      handled = true;

      try {
        const request = parseRequest(frame.body);
        const reply =
          request.type === 'stop'
            ? await handlers.stop(request)
            : await handlers.status(request);
        closeOnFinished(socket, encodeFrame(normalizeReply(reply)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        closeOnFinished(socket, encodeError(message));
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      void finish();
    });
    socket.on('error', () => {
      /* client-side disconnects are expected to close the connection */
    });
  });

  server.on('close', () => {
    unlinkIfPresent(absPath);
  });

  server.listen(absPath);
  return server;
}

/**
 * Send one control request and wait for the JSON reply.
 */
export async function request(absPath: string, message: ControlRequest): Promise<ControlReply> {
  assertAbs(absPath);
  const requestMessage = RequestSchema.parse(message);

  return await new Promise<ControlReply>((resolve, reject) => {
    const socket = net.createConnection(absPath);
    let buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const succeed = (reply: ControlReply): void => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(reply);
    };

    socket.on('connect', () => {
      socket.end(encodeFrame(requestMessage));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = decodeFrame(buffer);
      if (frame === null) return;
      try {
        const parsed = ReplySchema.parse(JSON.parse(frame.body.toString('utf8')));
        succeed(parsed);
      } catch (err) {
        fail(err);
      }
    });

    socket.on('end', () => {
      if (!settled) {
        fail(new Error('control socket closed before reply was received'));
      }
    });

    socket.on('error', fail);
  });
}
