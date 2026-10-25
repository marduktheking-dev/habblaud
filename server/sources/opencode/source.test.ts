// Integração da fonte do OpenCode: os eventos normalizados do plugin (POST /api/opencode/events chegam por
// applyEvent) + o AccountsService + o Office, sem banco e sem arquivos além das pastas de conta.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { SPECIAL } from '../../../shared/activity';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { OpenCodeSource } from './source';
import type { OpenCodeMessage, OpenCodeTotals, OpenCodeTranscriptReader } from './transcript';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const ROOT = mkdtempSync(join(tmpdir(), 'habblaud-opencode-'));
cleanups.push(() => rmSync(ROOT, { recursive: true, force: true }));

/** Uma pasta de conta (só precisa existir para o AccountsService; o plugin é quem traz a sessão). */
function accountDir(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Leitor do banco de mentira. As linhas ficam num array vivo, como no SQLite do OpenCode: a última mensagem é
 * atualizada NO LUGAR (texto chegando, ferramenta concluindo), então `since` sempre relê o estado atual.
 */
class FakeReader implements OpenCodeTranscriptReader {
  rows: OpenCodeMessage[] = [];
  totalsValue: OpenCodeTotals | undefined;
  closed = false;

  recent(_sessionId: string, limit: number): { rows: OpenCodeMessage[]; more: boolean } {
    return { rows: this.rows.slice(-limit), more: this.rows.length > limit };
  }
  since(_sessionId: string, seq: number): OpenCodeMessage[] {
    return this.rows.filter((r) => r.seq >= seq);
  }
  totals(): OpenCodeTotals | undefined {
    return this.totalsValue;
  }
  close(): void {
    this.closed = true;
  }
}

function userMsg(seq: number, text: string): OpenCodeMessage {
  return { id: `m${seq}`, type: 'user', seq, at: 1_000 + seq, data: { time: { created: 1_000 + seq }, text } };
}

function assistantMsg(seq: number, content: unknown[]): OpenCodeMessage {
  return { id: `m${seq}`, type: 'assistant', seq, at: 1_000 + seq, data: { time: { created: 1_000 + seq, completed: 2_000 + seq }, agent: 'build', content } };
}

function setup(opts: { names?: string[]; presenceMs?: number; quietMs?: number; toolMaxMs?: number; reader?: FakeReader } = {}) {
  const dirs = (opts.names ?? ['opencode']).map(accountDir);
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: ROOT, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new OpenCodeSource({
    accounts,
    office,
    dirs,
    env: {},
    home: ROOT,
    now,
    presenceMs: opts.presenceMs,
    workingQuietMs: opts.quietMs,
    toolMaxMs: opts.toolMaxMs,
    transcriptReader: opts.reader ? () => opts.reader : undefined,
  });
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];

  const event = (payload: Record<string, unknown>): boolean => source.applyEvent(undefined, payload);

  return {
    dirs,
    accounts,
    office,
    source,
    notices,
    event,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id?: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => (id ? a.id === id : a.kind === 'main'));
    },
  };
}

const CHECKOUT = '/projetos/loja';

describe('fonte do OpenCode: sessão principal', () => {
  it('create + turno + ferramenta: agente na sala do projeto, com título, modelo e atividade', () => {
    const ctx = setup();
    ctx.source.boot();
    const at = ctx.now();
    expect(
      ctx.event({
        id: 'e1',
        type: 'session.create',
        sessionID: 'ses_1',
        directory: CHECKOUT,
        at,
        title: 'Corrigir o login',
        agent: 'build',
        model: 'opencode/big-pickle',
      }),
    ).toBe(true);
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'opencode',
      account: 'opencode',
      sessionId: 'ses_1',
      roomId: CHECKOUT,
      role: 'Agente principal (OpenCode)',
      status: 'idle',
      title: 'Corrigir o login',
      model: 'opencode/big-pickle',
    });
    expect(ctx.source.sources()).toEqual([{ label: 'opencode', provider: 'opencode', path: ctx.dirs[0], sessions: 1, ok: true }]);
    expect(ctx.accounts.allEntries().map((e) => [e.id, e.provider])).toEqual([['opencode', 'opencode']]);

    expect(ctx.event({ id: 'e2', type: 'session.turn.start', sessionID: 'ses_1', at: at + 1 })).toBe(true);
    expect(ctx.agent()?.status).toBe('working');

    expect(ctx.event({ id: 'e3', type: 'tool.start', sessionID: 'ses_1', at: at + 2, tool: 'shell', toolId: 't1' })).toBe(true);
    expect(ctx.agent()?.activity).toMatchObject({ id: `opencode:ses_1#t1`, text: 'Rodando um comando no terminal' });
    expect(ctx.agent()?.status).toBe('working');

    expect(ctx.event({ id: 'e4', type: 'tool.end', sessionID: 'ses_1', at: at + 3, toolId: 't1', ok: true })).toBe(true);
    expect(ctx.event({ id: 'e5', type: 'session.turn.end', sessionID: 'ses_1', at: at + 4, result: 'ok' })).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('rename, modelo e agente se refletem no escritório', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now(), title: 'Antes' });
    expect(ctx.agent()?.title).toBe('Antes');
    ctx.event({ id: 'e2', type: 'session.rename', sessionID: 'ses_1', at: ctx.now(), title: 'Depois' });
    expect(ctx.agent()?.title).toBe('Depois');
    ctx.event({ id: 'e3', type: 'session.model', sessionID: 'ses_1', at: ctx.now(), model: 'anthropic/claude' });
    expect(ctx.agent()?.model).toBe('anthropic/claude');
  });

  it('sem pasta de projeto o agente não entra; um evento com a pasta o traz na hora', () => {
    const ctx = setup();
    ctx.source.boot();
    expect(ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', at: ctx.now(), title: 'Sem pasta' })).toBe(true);
    expect(ctx.agents()).toEqual([]);
    expect(ctx.office.commit().snapshot.rooms).toEqual([]);
    expect(ctx.event({ id: 'e2', type: 'session.move', sessionID: 'ses_1', at: ctx.now(), directory: CHECKOUT })).toBe(true);
    expect(ctx.agent()).toMatchObject({ roomId: CHECKOUT, title: 'Sem pasta' });
  });

  it('pedido de permissão espera e a resposta volta a trabalhar; erro aparece na atividade', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    ctx.event({ id: 'e2', type: 'session.turn.start', sessionID: 'ses_1', at: ctx.now() + 1 });
    ctx.event({ id: 'e3', type: 'session.permission', sessionID: 'ses_1', at: ctx.now() + 2, asking: true });
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    ctx.event({ id: 'e4', type: 'session.permission', sessionID: 'ses_1', at: ctx.now() + 3, asking: false });
    expect(ctx.agent()?.status).toBe('working');
    ctx.event({ id: 'e5', type: 'session.error', sessionID: 'ses_1', at: ctx.now() + 4 });
    expect(ctx.agent()?.activity?.kind).toBe('error');
  });

  it('evento desconhecido, sem tipo, sem sessão ou repetido: não inventa nada', () => {
    const ctx = setup();
    ctx.source.boot();
    expect(ctx.event({ id: 'x1', type: 'nope', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() })).toBe(false);
    expect(ctx.event({ id: 'x2', sessionID: 'ses_1' })).toBe(false);
    expect(ctx.event({ id: 'x3', type: 'session.create', directory: CHECKOUT })).toBe(false);
    const ev = { id: 'x4', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() };
    expect(ctx.event(ev)).toBe(true);
    expect(ctx.event(ev)).toBe(true); // mesmo id: já aplicado, mas contado como aceito
    expect(ctx.agents()).toHaveLength(1);
  });

  it('sessão de shell (sh_) fica de fora: o terminal de cada comando não é gente trabalhando', () => {
    const ctx = setup();
    ctx.source.boot();
    const sh = 'sh_151252d97001xvivod41U0kw6n';
    expect(ctx.event({ id: 'sh1', type: 'session.create', sessionID: sh, directory: CHECKOUT, at: ctx.now() })).toBe(false);
    expect(ctx.event({ id: 'sh2', type: 'session.turn.start', sessionID: sh, at: ctx.now() })).toBe(false);
    expect(ctx.event({ id: 'sh3', type: 'session.usage', sessionID: sh, at: ctx.now() })).toBe(false);
    ctx.poll();
    expect(ctx.agents()).toHaveLength(0); // nem sala, nem agente
    // A sessão de trabalho de verdade continua entrando normalmente.
    expect(ctx.event({ id: 'ok1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() })).toBe(true);
    ctx.poll();
    expect(ctx.agents()).toHaveLength(1);
  });
});

describe('fonte do OpenCode: presença', () => {
  it('sem eventos por presenceMs a sessão sai; session.delete fecha na hora', () => {
    const ctx = setup({ presenceMs: 10_000 });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    expect(ctx.agent()).toBeDefined();
    ctx.advance(9_000);
    ctx.poll();
    expect(ctx.agent()?.status).not.toBe('offline');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent('opencode:ses_1')?.status).toBe('offline');
    // A folga de saída passa: o agente some de vez.
    ctx.advance(20_000);
    ctx.poll();
    expect(ctx.agent('opencode:ses_1')).toBeUndefined();

    ctx.event({ id: 'e2', type: 'session.create', sessionID: 'ses_2', directory: CHECKOUT, at: ctx.now() });
    expect(ctx.agent('opencode:ses_2')).toBeDefined();
    ctx.event({ id: 'e3', type: 'session.delete', sessionID: 'ses_2', at: ctx.now() });
    expect(ctx.agent('opencode:ses_2')?.status).toBe('offline');
    ctx.advance(20_000);
    ctx.poll();
    expect(ctx.agent('opencode:ses_2')).toBeUndefined();
  });

  it("'working' calado vira 'idle' depois de quietMs", () => {
    const ctx = setup({ presenceMs: 60_000, quietMs: 5_000 });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    ctx.event({ id: 'e2', type: 'session.turn.start', sessionID: 'ses_1', at: ctx.now() });
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(6_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('uma ferramenta em voo segura a presença mesmo calada (até toolMaxMs)', () => {
    const ctx = setup({ presenceMs: 10_000, quietMs: 5_000, toolMaxMs: 60_000 });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    ctx.event({ id: 'e2', type: 'tool.start', sessionID: 'ses_1', at: ctx.now(), tool: 'shell', toolId: 't1' });
    // Muito além da janela de presença: enquanto a ferramenta não termina, o agente fica.
    ctx.advance(30_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    // Fim da ferramenta: aí a janela de presença volta a contar.
    ctx.event({ id: 'e3', type: 'tool.end', sessionID: 'ses_1', at: ctx.now(), toolId: 't1', ok: true });
    ctx.advance(11_000);
    ctx.poll();
    expect(ctx.agent('opencode:ses_1')?.status).toBe('offline');
  });

  it('ferramenta presa além do teto não segura a sessão para sempre', () => {
    const ctx = setup({ presenceMs: 10_000, toolMaxMs: 20_000 });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    ctx.event({ id: 'e2', type: 'tool.start', sessionID: 'ses_1', at: ctx.now(), tool: 'shell', toolId: 't1' });
    ctx.advance(21_000);
    ctx.poll(); // solta a ferramenta presa; a janela de presença (10 s) já passou também
    expect(ctx.agent('opencode:ses_1')?.status).toBe('offline');
  });
});

describe('fonte do OpenCode: subagentes', () => {
  it('sub entra sob o pai, entrega ao ficar ocioso e volta a trabalhar', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_main', directory: CHECKOUT, at: ctx.now() });
    ctx.event({ id: 'e2', type: 'session.turn.start', sessionID: 'ses_main', at: ctx.now() + 1 });
    ctx.event({
      id: 'e3',
      type: 'session.create',
      sessionID: 'ses_sub',
      directory: CHECKOUT,
      at: ctx.now() + 2,
      parentID: 'ses_main',
      agent: 'explore',
    });
    // Ainda não trabalhou: fica ocioso, não "done".
    expect(ctx.agent('opencode:ses_sub')).toMatchObject({ kind: 'sub', status: 'idle' });
    ctx.event({ id: 'e4', type: 'session.turn.start', sessionID: 'ses_sub', at: ctx.now() + 3 });
    expect(ctx.agent('opencode:ses_sub')).toMatchObject({
      kind: 'sub',
      provider: 'opencode',
      parentId: 'opencode:ses_main',
      sessionId: 'ses_sub',
      role: 'Explore',
      status: 'working',
      roomId: CHECKOUT,
    });
    ctx.event({ id: 'e5', type: 'session.turn.end', sessionID: 'ses_sub', at: ctx.now() + 4, result: 'ok' });
    ctx.poll();
    expect(ctx.agent('opencode:ses_sub')?.status).toBe('done');
    expect(ctx.notices.some((n) => n.text.includes('entregou'))).toBe(true);
    ctx.event({ id: 'e6', type: 'session.turn.start', sessionID: 'ses_sub', at: ctx.now() + 5 });
    expect(ctx.agent('opencode:ses_sub')?.status).toBe('working');
  });

  it('sub sem o pai no escritório não entra', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_sub', directory: CHECKOUT, at: ctx.now(), parentID: 'ses_main' });
    expect(ctx.agents()).toEqual([]);
  });
});

describe('fonte do OpenCode: contas', () => {
  it('uma conta só (o normal): "OpenCode", letra O, sem colidir com as outras ferramentas', () => {
    const ctx = setup();
    ctx.source.boot();
    expect(ctx.accounts.list(new Map())).toMatchObject([{ id: 'opencode', provider: 'opencode', name: 'OpenCode', short: 'O' }]);
    expect(ctx.source.accountEntries().map((e) => e.id)).toEqual(['opencode']);
  });

  it('duas contas: nomes "OpenCode O" e "OpenCode T", letras e cores distintas', () => {
    const ctx = setup({ names: ['opencode', 'opencode-trabalho'] });
    ctx.source.boot();
    const list = ctx.accounts.list(new Map());
    expect(list.map((a) => [a.provider, a.name])).toEqual([
      ['opencode', 'OpenCode O'],
      ['opencode', 'OpenCode T'],
    ]);
    expect(new Set(list.map((a) => a.short)).size).toBe(2);
    expect(new Set(list.map((a) => a.color)).size).toBe(2);
  });
});

describe('fonte do OpenCode: terminal ao vivo (banco) e números', () => {
  it('init com as últimas entradas e append só do que é novo', () => {
    const reader = new FakeReader();
    reader.rows = [userMsg(4, 'qual o comando?')];
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now(), title: 'T' });

    const conv = ctx.source.liveConversation('opencode:ses_1');
    expect(conv).toBeDefined();
    expect(conv!.load(500)).toMatchObject({ truncated: false, entries: [{ kind: 'user', text: 'qual o comando?' }] });
    expect(conv!.poll()).toEqual([]);

    // A resposta chega: aparece no próximo ciclo e não se repete.
    reader.rows.push(assistantMsg(6, [{ type: 'text', text: 'É o iniciar.sh' }]));
    expect(conv!.poll().map((e) => [e.kind, e.kind === 'assistant' ? e.text : ''])).toEqual([['assistant', 'É o iniciar.sh']]);
    expect(conv!.poll()).toEqual([]);
  });

  it('a mesma linha mudando no lugar (ferramenta concluindo) só completa o resultado, sem repetir a ferramenta', () => {
    const reader = new FakeReader();
    reader.rows = [assistantMsg(5, [{ type: 'tool', id: 'call_1', name: 'shell', state: { status: 'running', input: { command: 'npm test' } } }])];
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    const conv = ctx.source.liveConversation('opencode:ses_1')!;
    expect(conv.load(500).entries.map((e) => e.kind)).toEqual(['tool']);
    reader.rows[0] = assistantMsg(5, [{ type: 'tool', id: 'call_1', name: 'shell', state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: 'tudo verde' }] } }]);
    expect(conv.poll()).toMatchObject([{ kind: 'result', toolUseId: 'call_1', text: 'tudo verde' }]);
    expect(conv.poll()).toEqual([]);
  });

  it('o init recorta no limite e marca truncated', () => {
    const reader = new FakeReader();
    for (let i = 1; i <= 10; i++) reader.rows.push(userMsg(i, `pergunta ${i}`));
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    const init = ctx.source.liveConversation('opencode:ses_1')!.load(4);
    expect(init.entries).toHaveLength(4);
    expect(init.truncated).toBe(true);
    expect(init.entries[0]).toMatchObject({ text: 'pergunta 7' });
  });

  it('tokens, custo e ferramentas reais vão para o escritório', () => {
    const reader = new FakeReader();
    reader.totalsValue = { toolCalls: 12, tokensIn: 1_500, tokensOut: 300, costUSD: 0.25 };
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now(), title: 'T' });
    expect(ctx.agent()?.stats).toEqual({ toolCalls: 12, tokensIn: 1_500, tokensOut: 300, subagents: 0, costUSD: 0.25 });
  });

  it('o título automático e as tarefas vêm do banco (o plugin não manda nem um nem outro)', () => {
    const reader = new FakeReader();
    reader.totalsValue = {
      toolCalls: 2,
      tokensIn: 10,
      tokensOut: 20,
      title: 'Comando para iniciar a estação',
      tasks: [{ id: '1', title: 'Arrumar o login', status: 'in_progress' }],
    };
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    expect(ctx.agent()).toMatchObject({
      title: 'Comando para iniciar a estação',
      tasks: [{ id: '1', title: 'Arrumar o login', status: 'in_progress' }],
    });
  });

  it('o título do evento manda sobre o do banco: o renome aparece na hora', () => {
    const reader = new FakeReader();
    reader.totalsValue = { toolCalls: 0, tokensIn: 0, tokensOut: 0, title: 'Título automático' };
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now(), title: 'Loja' });
    expect(ctx.agent()?.title).toBe('Loja');
    ctx.event({ id: 'e2', type: 'session.rename', sessionID: 'ses_1', at: ctx.now(), title: 'Depois' });
    expect(ctx.agent()?.title).toBe('Depois');
  });

  it('o fim do turno relê o banco: o título automático e as tarefas chegam sem evento próprio', () => {
    const reader = new FakeReader();
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    expect(ctx.agent()?.title).toBeUndefined();
    // O OpenCode grava o título automático depois do primeiro pedido: o banco passa a tê-lo.
    reader.totalsValue = { toolCalls: 3, tokensIn: 10, tokensOut: 20, title: 'Comando para iniciar a estação', tasks: [{ id: '1', title: 'Arrumar o login', status: 'completed' }] };
    ctx.advance(11_000); // passou a validade dos totais (10 s): o fim do turno relê de verdade
    ctx.event({ id: 'e2', type: 'session.turn.end', sessionID: 'ses_1', at: ctx.now(), result: 'ok' });
    expect(ctx.agent()).toMatchObject({
      title: 'Comando para iniciar a estação',
      tasks: [{ id: '1', title: 'Arrumar o login', status: 'completed' }],
      stats: { toolCalls: 3, tokensIn: 10, tokensOut: 20, subagents: 0 },
    });
  });

  it('um aviso de uso novo relê os números na hora, sem esperar a validade dos totais', () => {
    const reader = new FakeReader();
    reader.totalsValue = { toolCalls: 1, tokensIn: 100, tokensOut: 10 };
    const ctx = setup({ reader });
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    expect(ctx.agent()?.stats).toMatchObject({ toolCalls: 1, tokensIn: 100, tokensOut: 10 });
    // Uso novo gravado no banco, mas ainda dentro da validade: um evento que só renova a presença não relê.
    reader.totalsValue = { toolCalls: 2, tokensIn: 250, tokensOut: 40 };
    ctx.advance(3_000);
    ctx.event({ id: 'e2', type: 'session.ping', sessionID: 'ses_1', at: ctx.now() });
    expect(ctx.agent()?.stats).toMatchObject({ toolCalls: 1, tokensIn: 100, tokensOut: 10 });
    // O aviso de uso relê (respeitando o intervalo mínimo de 2 s).
    ctx.event({ id: 'e3', type: 'session.usage', sessionID: 'ses_1', at: ctx.now() });
    expect(ctx.agent()?.stats).toMatchObject({ toolCalls: 2, tokensIn: 250, tokensOut: 40 });
  });

  it('sem banco: sem conversa e números zerados, sem inventar nada', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now(), title: 'T' });
    expect(ctx.source.liveConversation('opencode:ses_1')).toBeUndefined();
    expect(ctx.agent()?.stats).toMatchObject({ toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 });
  });

  it('sessão fora do escritório não tem conversa (nem agente)', () => {
    const reader = new FakeReader();
    const ctx = setup({ reader });
    ctx.source.boot();
    expect(ctx.source.liveConversation('opencode:ses_9')).toBeUndefined();
  });
});

describe('fonte do OpenCode: compactação e retentativa', () => {
  it('a compactação da memória vira atividade no escritório', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    ctx.event({ id: 'e2', type: 'session.compact', sessionID: 'ses_1', at: ctx.now() + 1 });
    expect(ctx.agent()?.activity).toMatchObject({ kind: 'compact', icon: '🧹' });
  });

  it('a retentativa da API vira atividade, no máximo uma vez por minuto', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.event({ id: 'e1', type: 'session.create', sessionID: 'ses_1', directory: CHECKOUT, at: ctx.now() });
    const retries = () => ctx.agent()!.recent.filter((a) => a.text === SPECIAL.apiRetry().text).length;
    ctx.event({ id: 'e2', type: 'session.retry', sessionID: 'ses_1', at: ctx.now() + 1 });
    expect(ctx.agent()?.activity).toMatchObject({ kind: 'wait', text: SPECIAL.apiRetry().text });
    expect(retries()).toBe(1);
    // Uma sequência de tentativas no mesmo minuto não vira uma pilha de avisos.
    ctx.event({ id: 'e3', type: 'session.retry', sessionID: 'ses_1', at: ctx.now() + 2 });
    expect(retries()).toBe(1);
    ctx.advance(61_000);
    ctx.event({ id: 'e4', type: 'session.retry', sessionID: 'ses_1', at: ctx.now() });
    expect(retries()).toBe(2);
  });
});
