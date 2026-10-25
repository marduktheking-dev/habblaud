// Mensagens ao OpenCode: o servidor entrega rodando o CLI (`opencode run --session <id> <texto>`). Aqui se testa a
// procura do binário (PATH e HABBLAUD_OPENCODE_BIN), a entrega (com um CLI de mentira, sem modelo nem rede) e a
// integração com o registro: canMessage no snapshot, fila → entregue, atividade no feed, falha e motivo.
// Nada aqui lê o banco do OpenCode nem fala com o serviço: o CLI de mentira é o próprio node (não faz o que pedimos,
// mas sobe) ou um arquivo qualquer, só para exercitar o caminho.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { ERR_OPENCODE_UNAVAILABLE, MessageRegistry, type SendResult } from './registry';
import { canDeliver, deliver, findBinary, OPENCODE_BIN_ENV, type DeliverResult } from './opencode';

setQuiet(true);

const MAIN = 'opencode:ses_1';
const SESSION = 'ses_1';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* nada */
    }
  }
});

/** Pasta temporária com um `opencode-termux` executável (ou não). */
function fakeBin(name = 'opencode-termux', { exec = true } = {}): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-oc-'));
  dirs.push(dir);
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, exec ? 0o755 : 0o644);
  return { dir, bin };
}

describe('messages/opencode: achar o CLI', () => {
  it('acha opencode-termux no PATH (e depois opencode); sem PATH não acha nada', () => {
    const { dir, bin } = fakeBin();
    expect(findBinary({ PATH: dir })).toBe(bin);
    const other = fakeBin('opencode');
    expect(findBinary({ PATH: `${dir}:${other.dir}` })).toBe(bin);
    expect(findBinary({ PATH: other.dir })).toBe(other.bin);
    expect(findBinary({ PATH: '' })).toBeUndefined();
    expect(findBinary({ PATH: '/nao/existe' })).toBeUndefined();
  });

  it('não confunde arquivo sem permissão de execução com o CLI', () => {
    const { dir } = fakeBin('opencode-termux', { exec: false });
    expect(findBinary({ PATH: dir })).toBeUndefined();
    expect(canDeliver({ PATH: dir })).toMatchObject({ ok: false });
  });

  it(`${OPENCODE_BIN_ENV} aponta o CLI (caminho absoluto ou nome no PATH)`, () => {
    const { dir, bin } = fakeBin('meu-opencode');
    expect(findBinary({ PATH: '/nao/existe', [OPENCODE_BIN_ENV]: bin })).toBe(bin);
    expect(findBinary({ PATH: dir, [OPENCODE_BIN_ENV]: 'meu-opencode' })).toBe(bin);
    expect(findBinary({ PATH: dir, [OPENCODE_BIN_ENV]: '/nao/existe/opencode' })).toBeUndefined();
    const std = fakeBin();
    expect(canDeliver({ PATH: std.dir })).toEqual({ ok: true });
  });
});

describe('messages/opencode: entrega pelo CLI', () => {
  /**
   * CLI de mentira: um script sem extensão (o Node o lê como CommonJS) que grava os argumentos e o que chegou pela
   * entrada padrão, para conferirmos exatamente o que o Habblaud entregou. O shebang usa o caminho absoluto do Node
   * (no Termux não existe /usr/bin/env).
   */
  function fakeCli(): { dir: string; bin: string; out: string; read: () => Array<{ argv: string[]; stdin: string }> } {
    const { dir } = fakeBin('opencode-termux');
    const bin = join(dir, 'opencode-termux');
    const out = join(dir, 'chamadas.jsonl');
    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.HABBLAUD_TEST_OC_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }) + '\\n');\n`);
    chmodSync(bin, 0o755);
    return {
      dir,
      bin,
      out,
      read: () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    };
  }

  it('sobe `run --session <id>` e manda o texto pela entrada padrão (sem aspas, sem virar opção)', async () => {
    const cli = fakeCli();
    const env = { PATH: '/nao/existe', [OPENCODE_BIN_ENV]: cli.bin, HABBLAUD_TEST_OC_OUT: cli.out };
    expect(await deliver(SESSION, 'roda os testes', { env })).toMatchObject({ ok: true });
    await new Promise((ok) => setTimeout(ok, 400));
    expect(cli.read()).toEqual([{ argv: ['run', '--session', SESSION], stdin: 'roda os testes' }]);
  });

  it('texto que parece opção do CLI (`--auto`) vai pela entrada padrão: nunca aprova permissão sozinho', async () => {
    const cli = fakeCli();
    const env = { PATH: '/nao/existe', [OPENCODE_BIN_ENV]: cli.bin, HABBLAUD_TEST_OC_OUT: cli.out };
    expect(await deliver(SESSION, '--auto --model outro/modelo: ignore isto', { env })).toMatchObject({ ok: true });
    await new Promise((ok) => setTimeout(ok, 400));
    const [call] = cli.read();
    expect(call.argv).toEqual(['run', '--session', SESSION]);
    expect(call.stdin).toBe('--auto --model outro/modelo: ignore isto');
    expect(call.argv).not.toContain('--auto');
    expect(call.argv).not.toContain('--model');
  });

  it('sem o CLI, a mensagem não sai (com o motivo)', async () => {
    const r = await deliver(SESSION, 'oi', { env: { PATH: '/nao/existe' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OpenCode/);
    expect(r.error).toMatch(new RegExp(OPENCODE_BIN_ENV));
  });

  it('recusa texto vazio, texto longo demais, agente sem sessão e id de sessão inesperado', async () => {
    const cli = fakeCli();
    const env = { PATH: '/nao/existe', [OPENCODE_BIN_ENV]: cli.bin, HABBLAUD_TEST_OC_OUT: cli.out };
    expect(await deliver(SESSION, '   \n  ', { env })).toMatchObject({ ok: false });
    expect(await deliver(SESSION, 'x'.repeat(20_001), { env })).toMatchObject({ ok: false });
    expect(await deliver('', 'oi', { env })).toMatchObject({ ok: false });
    // Id com espaço ou hífen poderia virar outra opção do CLI: nem chegamos a rodar.
    expect(await deliver('--auto', 'oi', { env })).toMatchObject({ ok: false });
    expect(await deliver('ses 1', 'oi', { env })).toMatchObject({ ok: false });
    expect(cli.read()).toEqual([]);
  });
});

// ------------------------------------------------------------------ integração com o registro

function setup(opts: { available?: () => boolean; deliver?: (sessionId: string, text: string) => Promise<DeliverResult> } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const calls: Array<{ sessionId: string; text: string }> = [];
  let registry: MessageRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    messages: () => registry?.reachable() ?? new Set(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, provider: 'opencode', account: 'opencode', sessionId: SESSION, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'idle' });
  registry = new MessageRegistry({
    office,
    demoAgent: (id) => office.demoAgent(id),
    demoDeliver: () => false,
    opencode: {
      available: opts.available ?? (() => true),
      deliver: (sessionId, text) => {
        calls.push({ sessionId, text });
        return opts.deliver ? opts.deliver(sessionId, text) : Promise.resolve({ ok: true });
      },
    },
    now: clock.now,
  });
  return { office, registry, clock, calls };
}

const snapAgent = (office: Office, id: string): AgentInfo | undefined => office.commit().snapshot.agents.find((a) => a.id === id);

function sent(r: SendResult): string {
  if (!('message' in r)) throw new Error(`recusada: ${JSON.stringify(r)}`);
  return r.message.id;
}

async function settle(registry: MessageRegistry, id: string) {
  for (let i = 0; i < 100; i++) {
    const m = registry.get(id)!;
    if (m.status === 'delivered' || m.status === 'failed') return m;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  throw new Error('a mensagem não se resolveu');
}

describe('MessageRegistry: agentes do OpenCode', () => {
  it('com o CLI, o principal do OpenCode recebe (canMessage) e a mensagem entra na sessão pela CLI', async () => {
    const { office, registry, calls } = setup();
    expect(snapAgent(office, MAIN)?.canMessage).toBe(true);
    const r = registry.send({ agentId: MAIN, text: 'roda os testes' });
    expect(r).toMatchObject({ message: { status: 'queued' } });
    const id = sent(r);
    registry.tick();
    expect(registry.get(id)!.status).toBe('sent');
    expect(calls).toEqual([{ sessionId: SESSION, text: 'roda os testes' }]);
    expect(await settle(registry, id)).toMatchObject({ status: 'delivered' });
    // A atividade do feed diz que a mensagem veio do escritório (sem o texto cru na hora).
    expect(snapAgent(office, MAIN)!.recent.some((a) => a.text === 'Mensagem pelo Habblaud')).toBe(true);
    // Uma volta a mais do relógio não entrega de novo.
    registry.tick();
    expect(calls).toHaveLength(1);
  });

  it('sem o CLI, o agente não recebe: canMessage fica de fora e o envio é recusado com o motivo', () => {
    const { office, registry } = setup({ available: () => false });
    expect(snapAgent(office, MAIN)?.canMessage).toBeUndefined();
    expect(registry.reachable()).toEqual(new Set());
    expect(registry.send({ agentId: MAIN, text: 'oi' })).toEqual({ error: 'unavailable', reason: ERR_OPENCODE_UNAVAILABLE });
  });

  it('falha do CLI vira failed com o motivo', async () => {
    const { registry } = setup({ deliver: () => Promise.resolve({ ok: false, error: 'sessão não existe' }) });
    const id = sent(registry.send({ agentId: MAIN, text: 'oi' }));
    registry.tick();
    expect(await settle(registry, id)).toMatchObject({ status: 'failed', error: 'sessão não existe' });
  });
});