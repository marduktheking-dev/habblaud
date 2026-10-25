// Rota dos eventos do OpenCode (POST /api/opencode/events): valida payload, respeita regra de loopback/local só,
// e aplica ao live. Repete o estilo dos testes de /api/codex/events com guard/app.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { OpenCodeLive } from '../sources/opencode/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { handleOpenCodeEvent, parseOpenCodeEvent } from './http';

setQuiet(true);

const BASE = 'http://127.0.0.1';
let temp: ReturnType<typeof tempDir> | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  if (temp) temp.cleanup();
  if (server) await new Promise((r) => server.close(r));
});

describe('server/opencode/http.ts', () => {
  it('parseOpenCodeEvent valida id e tipo', () => {
    expect(() => parseOpenCodeEvent(null)).toThrow();
    expect(() => parseOpenCodeEvent({ type: 123 })).toThrow();
    expect(() => parseOpenCodeEvent({ type: 'x', sessionID: 5 })).toThrow();
    expect(parseOpenCodeEvent({ type: 'tool.start', sessionID: 's' })).toEqual({ type: 'tool.start', sessionID: 's' });
    // tamanho
    const long = 'x'.repeat(81);
    expect(() => parseOpenCodeEvent({ type: long, sessionID: 's' })).toThrow();
    const longSid = 'x'.repeat(201);
    expect(() => parseOpenCodeEvent({ type: 't', sessionID: longSid })).toThrow();
  });

  it('handleOpenCodeEvent repassa ao live', async () => {
    const applied: unknown[] = [];
    const live: OpenCodeLive = {
      applyEvent: () => {
        applied.push('x');
        return true;
      },
    };
    let status = 0;
    let body = '';
    const req = new http.IncomingMessage(null as any);
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    (req as any).socket = { readable: true };
    (req as any).push(JSON.stringify({ type: 'tool.start', sessionID: 's' }));
    (req as any).push(null);
    const res = new http.ServerResponse(req) as any;
    res.writeHead = (c: number) => { status = c; };
    res.end = (b: string | Buffer) => { body = String(b ?? ''); };
    await handleOpenCodeEvent(req, res as any, { live });
    expect(applied).toHaveLength(1);
    expect(status).toBe(200);
    expect(body).toBe('{"ok":true}');
  });

  it('handleOpenCodeEvent responde {ok:false} quando live ausente', async () => {
    let status = 0;
    let body = '';
    const req = new http.IncomingMessage(null as any);
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    (req as any).push(JSON.stringify({ type: 'session.create', sessionID: 's1' }));
    (req as any).push(null);
    const res = new http.ServerResponse(req) as any;
    res.writeHead = (c: number) => { status = c; };
    res.end = (b: string | Buffer) => { body = String(b ?? ''); };
    await handleOpenCodeEvent(req, res as any, {});
    expect(status).toBe(200);
    expect(body).toBe('{"ok":false}');
  });
});
