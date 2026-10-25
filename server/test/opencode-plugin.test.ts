// O plugin do Habblaud (mod/habblaud-opencode/plugin.ts) é o que traduz os eventos REAIS do OpenCode para o
// vocabulário normalizado que a fonte do Habblaud entende. Aqui ele roda sem rede (o `fetch` é trocado) e cada
// pacote entregue é aplicado numa OpenCodeSource de verdade — assim o teste pega qualquer divergência entre os
// dois lados (nome de evento, campo, formato) que os testes separados não pegariam.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../../mod/habblaud-opencode/plugin';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { OpenCodeSource } from '../sources/opencode/source';

setQuiet(true);

const SESSION = 'ses_teste_01';
const DIR = '/projetos/loja';
const SECRET = 'SEGREDO-QUE-NAO-PODE-VAZAR';

type Rec = Record<string, unknown>;

const ROOT = mkdtempSync(join(tmpdir(), 'habblaud-plugin-'));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

/** Eventos reais do OpenCode (mesmo formato que o barramento entrega ao plugin). */
function realEvents(): Rec[] {
  const t = Date.now();
  return [
    { type: 'session.created', id: 'ev1', created: t + 1, location: { directory: DIR }, data: { sessionID: SESSION, title: 'Loja', agent: 'build', model: { providerID: 'opencode', id: 'big-pickle' } } },
    { type: 'session.execution.started', id: 'ev2', created: t + 2, data: { sessionID: SESSION } },
    { type: 'session.tool.input.started', id: 'ev3', created: t + 3, data: { sessionID: SESSION, name: 'shell', id: 'call_1' } },
    { type: 'session.tool.success', id: 'ev4', created: t + 4, data: { sessionID: SESSION, id: 'call_1' } },
    { type: 'permission.asked', id: 'ev5', created: t + 5, data: { sessionID: SESSION } },
    { type: 'permission.replied', id: 'ev6', created: t + 6, data: { sessionID: SESSION } },
    // O título automático não tem evento de renome próprio: ele chega no `session.updated` (que traz a sessão
    // inteira em `info`). O de baixo carrega o conteúdo da compactação e do erro — nada disso pode ser entregue.
    { type: 'session.updated', id: 'ev7', created: t + 7, data: { sessionID: SESSION, info: { id: SESSION, title: 'Corrigir o login', directory: DIR } } },
    { type: 'session.usage.recorded', id: 'ev8', created: t + 8, data: { sessionID: SESSION, source: 'title', cost: 0.01, tokens: { input: 10, output: 2, reasoning: 5, cache: { read: 0, write: 0 } } } },
    { type: 'session.usage.updated', id: 'ev9', created: t + 9, data: { sessionID: SESSION, cost: 0.02, tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { type: 'session.retry.scheduled', id: 'ev10', created: t + 10, data: { sessionID: SESSION, attempt: 2, at: t + 10, error: { message: SECRET } } },
    { type: 'session.compaction.started', id: 'ev11', created: t + 11, data: { sessionID: SESSION, reason: 'auto', recent: SECRET, inputID: SECRET } },
    { type: 'session.idle', id: 'ev12', created: t + 12, data: { sessionID: SESSION } },
    // Evento que não muda o escritório, mas carrega conteúdo privado: nada disso pode ser entregue.
    { type: 'message.part.updated', id: 'ev13', created: t + 13, location: { directory: DIR }, data: { sessionID: SESSION, text: SECRET, input: { command: SECRET }, result: SECRET } },
  ];
}

/** Só as chaves que o escritório precisa podem aparecer em qualquer pacote entregue. */
const ALLOWED_KEYS = new Set(['id', 'type', 'sessionID', 'directory', 'at', 'title', 'agent', 'model', 'parentID', 'tool', 'toolId', 'ok', 'status', 'asking', 'result', 'reason']);

/** Roda o plugin sobre os eventos e devolve os pacotes entregues (url + corpo). */
async function drive(events: Rec[]): Promise<Array<{ url: string; body: Rec }>> {
  const posted: Array<{ url: string; body: Rec }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      posted.push({ url: String(url), body: JSON.parse(init.body) as Rec });
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }),
  );
  async function* feed(): AsyncGenerator<Rec> {
    for (const e of events) yield e;
  }
  plugin.setup({ location: { directory: DIR }, event: { subscribe: () => feed() } });
  await new Promise((r) => setTimeout(r, 10));
  return posted;
}

describe('plugin do OpenCode → fonte do Habblaud', () => {
  beforeEach(() => {
    delete process.env.HABBLAUD_HOME;
    delete process.env.HABBLAUD_URL;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('traduz os eventos reais para o vocabulário do escritório, na ordem certa', async () => {
    const posted = await drive(realEvents());
    expect(posted.map((p) => p.body.type)).toEqual([
      'session.create',
      'session.turn.start',
      'tool.start',
      'tool.end',
      'session.permission',
      'session.permission',
      'session.rename',
      'session.usage',
      'session.usage',
      'session.retry',
      'session.compact',
      'session.status',
      'session.ping',
    ]);
    const of = (t: string) => posted.filter((p) => p.body.type === t).map((p) => p.body);
    expect(of('session.permission').map((p) => p.asking)).toEqual([true, false]);
    expect(of('tool.start')[0]).toMatchObject({ tool: 'shell', toolId: 'call_1' });
    expect(of('tool.end')[0]).toMatchObject({ ok: true, toolId: 'call_1' });
    expect(of('session.status')[0]).toMatchObject({ status: 'idle' });
    expect(of('session.rename')[0]).toMatchObject({ title: 'Corrigir o login' });
    expect(posted[0]?.body).toMatchObject({ type: 'session.create', sessionID: SESSION, directory: DIR, title: 'Loja', agent: 'build', model: 'opencode/big-pickle' });
  });

  it('o título automático chega pelo session.updated, uma vez só', async () => {
    const t = Date.now();
    const created = { type: 'session.created', id: 'c1', created: t, location: { directory: DIR }, data: { sessionID: SESSION } };
    // O barramento manda a sessão inteira em `info` (e a cada mudança dela): o título só interessa quando muda.
    const updated = { type: 'session.updated', id: 'u1', created: t + 1, data: { sessionID: SESSION, info: { id: SESSION, title: 'Comando para iniciar a estação', directory: DIR } } };
    const again = { type: 'session.updated', id: 'u2', created: t + 2, data: { sessionID: SESSION, info: { id: SESSION, title: 'Comando para iniciar a estação', directory: DIR } } };
    const posted = await drive([created, updated, again]);
    expect(posted.map((p) => p.body.type)).toEqual(['session.create', 'session.rename']);
    expect(posted[1]?.body).toMatchObject({ title: 'Comando para iniciar a estação', directory: DIR });
  });

  it('o session.created do barramento (sessão em info) também traz título, agente, modelo e pasta', async () => {
    const info = { id: SESSION, title: 'Teste de subagente', agent: 'explore', model: { providerID: 'opencode', id: 'big-pickle' }, parentID: 'ses_pai', directory: DIR };
    const posted = await drive([{ type: 'session.created', id: 'c1', created: Date.now(), data: { sessionID: SESSION, info } }]);
    expect(posted[0]?.body).toMatchObject({ type: 'session.create', title: 'Teste de subagente', agent: 'explore', model: 'opencode/big-pickle', parentID: 'ses_pai', directory: DIR });
  });

  it('as sessões de shell (sh_) ficam de fora: o terminal de cada comando não é gente trabalhando', async () => {
    const t = Date.now();
    const sh = 'sh_151252d97001xvivod41U0kw6n';
    const posted = await drive([
      { type: 'session.created', id: 'sh1', created: t, location: { directory: DIR }, data: { sessionID: sh } },
      { type: 'session.execution.started', id: 'sh2', created: t + 1, data: { sessionID: sh } },
      { type: 'session.tool.input.started', id: 'sh3', created: t + 2, data: { sessionID: sh, name: 'bash', id: 'call_sh' } },
      { type: 'session.updated', id: 'sh4', created: t + 3, data: { sessionID: sh, info: { id: sh, title: 'qualquer comando', directory: DIR } } },
      // A sessão de trabalho de verdade continua passando.
      { type: 'session.created', id: 'n1', created: t + 4, location: { directory: DIR }, data: { sessionID: SESSION, title: 'Loja' } },
    ]);
    expect(posted.map((p) => p.body.type)).toEqual(['session.create']);
    expect(posted[0]?.body).toMatchObject({ sessionID: SESSION, title: 'Loja' });
  });

  it('nunca entrega prompt, resposta, argumentos de ferramenta nem outras chaves', async () => {
    const posted = await drive(realEvents());
    expect(JSON.stringify(posted)).not.toContain(SECRET);
    const seen = new Set(posted.flatMap((p) => Object.keys(p.body)));
    for (const k of seen) expect(ALLOWED_KEYS.has(k), `chave inesperada: ${k}`).toBe(true);
    for (const k of ['prompt', 'text', 'delta', 'input', 'result', 'args', 'command']) expect(seen.has(k)).toBe(false);
  });

  it('não repete o mesmo id de evento', async () => {
    const [a, b, c] = realEvents();
    const posted = await drive([a, a, b, c]);
    expect(posted.filter((p) => p.body.type === 'session.create')).toHaveLength(1);
    expect(posted.filter((p) => p.body.type === 'session.turn.start')).toHaveLength(1);
  });

  it('lê a url de ~/.habblaud/opencode-plugin.json (gravado pelo instalador)', async () => {
    const home = join(ROOT, 'casa');
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    process.env.HABBLAUD_HOME = home;
    writeFileSync(join(home, '.habblaud', 'opencode-plugin.json'), JSON.stringify({ url: 'http://127.0.0.1:4899' }));
    const posted = await drive([realEvents()[0]]);
    expect(posted[0]?.url).toBe('http://127.0.0.1:4899/api/opencode/events');
  });

  it('com o Habblaud fora do ar não lança e volta a entregar quando ele volta', async () => {
    const calls: string[] = [];
    let failures = 2;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push((JSON.parse(init.body) as Rec).type as string);
        if (failures-- > 0) throw new Error('ECONNREFUSED');
        return { ok: true } as Response;
      }),
    );
    const ev = realEvents();
    const feed = async function* () {
      for (const e of ev) yield e;
    };
    expect(() => plugin.setup({ location: { directory: DIR }, event: { subscribe: () => feed() } })).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    // Mesmo com as primeiras entregas falhando, o plugin seguiu tentando: quando o Habblaud volta, chega tudo.
    expect(calls.length).toBe(13);
    expect(calls.slice(0, 2)).toEqual(['session.create', 'session.turn.start']);
    expect(calls).toContain('session.status');
  });

  it('sem event.subscribe (ou sem ctx) o plugin fica inerte, sem lançar', () => {
    expect(() => plugin.setup({ location: { directory: DIR } })).not.toThrow();
    expect(() => plugin.setup({})).not.toThrow();
    expect(() => plugin.setup(undefined)).not.toThrow();
  });

  it('os pacotes entregues, aplicados numa OpenCodeSource de verdade, viram um agente do escritório', async () => {
    const posted = await drive(realEvents());
    const accountDir = join(ROOT, 'opencode');
    mkdirSync(accountDir, { recursive: true });
    const now = () => Date.now();
    const accounts = new AccountsService({ dirs: [], home: ROOT, env: {}, now, onChange: () => {} });
    const office = new Office({
      names: new NameStore(null),
      version: 'teste',
      startedAt: Date.now(),
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: (id) => accounts.find(id)?.detected.name,
      now,
    });
    const source = new OpenCodeSource({ accounts, office, dirs: [accountDir], env: {}, home: ROOT, now });
    try {
      for (const p of posted) expect(source.applyEvent(undefined, p.body), `recusou ${String(p.body.type)}`).toBe(true);
      source.poll();
      const agent = office.commit().snapshot.agents.find((a) => a.provider === 'opencode');
      expect(agent).toMatchObject({ provider: 'opencode', sessionId: SESSION, roomId: DIR, model: 'opencode/big-pickle', status: 'idle' });
    } finally {
      source.stop();
    }
  });
});
