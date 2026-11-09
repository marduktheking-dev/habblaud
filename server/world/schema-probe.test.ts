// A sonda do contrato publicado (server/world/schema-probe.ts) é a leitura que decide se um agente do OpenCode pode
// entrar no pacote do prédio: lê shared/world/schema.json do repositório público, confere o formato do `provider.enum`
// e conta as leituras que trouxeram "opencode" (o gate exige duas). Nada aqui fala com o servidor do mundo — só com o
// fetch injetado do teste.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  providerEnumOf,
  SCHEMA_PROBE_EVERY_MS,
  SCHEMA_PATH,
  schemaRawUrl,
  WorldSchemaProbe,
} from './schema-probe';
import { openCodeGate, OPENCODE_PROBE_MAX_AGE_MS, type OpenCodeGateState } from '../../shared/world/opencode-gate';

const REPO = 'marmottajr/habblaud';
const schemaOf = (providers: string[]) => ({ $defs: { agent: { properties: { provider: { enum: providers } } } } });
let now = 1_760_000_000_000;
const clock = () => now;

const probes: WorldSchemaProbe[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const p of probes.splice(0)) p.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

/** Sonda com fetch de mentira que devolve `providers` (ou erro) e guarda o que foi pedido. */
function makeProbe(opts: { providers?: string[]; status?: number; file?: string | null; enabled?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const status = opts.status ?? 200;
  const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (status !== 200) return new Response('não deu', { status });
    return new Response(JSON.stringify(schemaOf(opts.providers ?? ['claude', 'codex'])), {
      status: 200,
      headers: { ETag: '"v1"' },
    });
  });
  const p = new WorldSchemaProbe({
    repo: REPO,
    enabled: opts.enabled ?? true,
    file: opts.file === undefined ? null : opts.file,
    fetch: fetchFn as unknown as typeof fetch,
    now: clock,
  });
  probes.push(p);
  return { p, calls, fetchFn };
}

const gateState = (probe: ReturnType<WorldSchemaProbe['get']>, flag = true): OpenCodeGateState => ({ flag, probe, now });

describe('providerEnumOf: o formato do contrato', () => {
  it('lê o enum e tira repetido', () => {
    expect(providerEnumOf(schemaOf(['claude', 'codex', 'opencode']))).toEqual(['claude', 'codex', 'opencode']);
    expect(providerEnumOf(schemaOf(['claude', 'claude', 'codex']))).toEqual(['claude', 'codex']);
  });

  it('derruba quem chamou em tudo que não for lista de strings (nunca devolve "acho que aceita")', () => {
    expect(() => providerEnumOf({})).toThrow(/provider.enum/);
    expect(() => providerEnumOf(schemaOf([]))).toThrow(/provider.enum/);
    expect(() => providerEnumOf({ $defs: { agent: { properties: { provider: { enum: ['claude', 7] } } } } })).toThrow(/provider.enum/);
    expect(() => providerEnumOf({ $defs: { agent: { properties: { provider: 'claude' } } } })).toThrow(/provider.enum/);
    expect(() => providerEnumOf(null)).toThrow(/provider.enum/);
  });
});

describe('WorldSchemaProbe: a leitura do contrato publicado', () => {
  it('vai na URL crua do repositório público, sem token nem credencial', async () => {
    const { p, calls } = makeProbe();
    await p.check();
    expect(calls[0].url).toBe(schemaRawUrl(REPO));
    expect(calls[0].url).toContain(SCHEMA_PATH);
    expect(JSON.stringify(calls[0].headers)).not.toMatch(/token|authorization|cookie/i);
  });

  it('duas leituras com opencode abrem o gate; uma só não (o gate exige duas)', async () => {
    const { p } = makeProbe({ providers: ['claude', 'codex', 'opencode'] });
    await p.check();
    expect(p.get()).toMatchObject({ providers: ['claude', 'codex', 'opencode'], observations: 1, opencodeObservations: 1 });
    expect(openCodeGate(gateState(p.get()))).toMatchObject({ allowed: false, reason: 'unknown_remote' });
    now += 3_600_000;
    await p.check();
    expect(p.get().observations).toBe(2);
    expect(openCodeGate(gateState(p.get()))).toMatchObject({ allowed: true, reason: 'open' });
  });

  it('sem opencode no enum: a contagem de opencode zera e o motivo é remote_denied', async () => {
    const { p } = makeProbe({ providers: ['claude', 'codex'] });
    await p.check();
    await p.check();
    expect(p.get()).toMatchObject({ observations: 2, opencodeObservations: 0 });
    expect(openCodeGate(gateState(p.get()))).toMatchObject({ allowed: false, reason: 'remote_denied' });
  });

  it('304 (ETag) é uma leitura confirmada e manda o cabeçalho If-None-Match na volta', async () => {
    const { p, fetchFn } = makeProbe({ providers: ['claude', 'codex', 'opencode'] });
    await p.check();
    now += 3_600_000;
    fetchFn.mockImplementationOnce(async (_url: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.['If-None-Match']).toBe('"v1"');
      return new Response(null, { status: 304 });
    });
    await p.check();
    expect(p.get()).toMatchObject({ observations: 2, opencodeObservations: 2, providers: ['claude', 'codex', 'opencode'] });
    expect(openCodeGate(gateState(p.get())).allowed).toBe(true);
  });

  it('HTTP 502 não derruba: guarda o erro, o gate fica fechado e a sonda segue viva', async () => {
    const { p } = makeProbe({ status: 502 });
    await expect(p.check()).resolves.toBeUndefined();
    expect(p.get()).toMatchObject({ error: expect.stringContaining('502') });
    expect(p.get().checkedAt).toBeUndefined();
    expect(openCodeGate(gateState(p.get()))).toMatchObject({ allowed: false, reason: 'unknown_remote' });
    expect(p.enabled).toBe(true);
  });

  it('desligada não consulta nada (HABBLAUD_WORLD_OPENCODE=0 ou sem repositório)', async () => {
    const { p, fetchFn } = makeProbe({ enabled: false });
    await p.check();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(p.enabled).toBe(false);

    const f2 = vi.fn();
    const semRepo = new WorldSchemaProbe({ enabled: true, file: null, fetch: f2 as unknown as typeof fetch, now: clock });
    probes.push(semRepo);
    await semRepo.check();
    expect(f2).not.toHaveBeenCalled();
    expect(semRepo.enabled).toBe(false);
    expect(semRepo.get()).toEqual({ observations: 0, opencodeObservations: 0 });
  });

  it('guarda e relê o resultado: uma reiniciada não volta a pedir duas leituras do zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-schema-'));
    dirs.push(dir);
    const file = join(dir, 'world-schema.json');
    const { p } = makeProbe({ providers: ['claude', 'codex', 'opencode'], file });
    await p.check();
    await p.check();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ repo: REPO, observations: 2, opencodeObservations: 2 });

    const { p: after } = makeProbe({ providers: ['claude', 'codex', 'opencode'], file });
    after.load();
    expect(after.get()).toMatchObject({ observations: 2, providers: ['claude', 'codex', 'opencode'] });
    expect(openCodeGate(gateState(after.get()))).toMatchObject({ allowed: true, reason: 'open' });
  });

  it('arquivo de outra sessão/repositório não vale (confere o repo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-schema-'));
    dirs.push(dir);
    const file = join(dir, 'world-schema.json');
    writeFileSync(file, JSON.stringify({ repo: 'outra/pessoa', checkedAt: now, observations: 9 }));
    const { p } = makeProbe({ file });
    p.load();
    expect(p.get().checkedAt).toBeUndefined();
  });

  it('leitura vencida não decide mais (folga de 7 h sobre a periodicidade de 6 h)', async () => {
    const { p } = makeProbe({ providers: ['claude', 'codex', 'opencode'] });
    await p.check();
    await p.check();
    expect(openCodeGate(gateState(p.get())).allowed).toBe(true);
    now += OPENCODE_PROBE_MAX_AGE_MS + 1;
    expect(openCodeGate(gateState(p.get()))).toMatchObject({ allowed: false, reason: 'unknown_remote' });
    expect(SCHEMA_PROBE_EVERY_MS).toBe(6 * 3_600_000);
  });
});
