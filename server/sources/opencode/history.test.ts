// Histórico do OpenCode: sessões recentes lidas do banco (session_v2), com a janela de 7 dias, o filtro de
// formato do id e o resolve() que devolve a conversa derivada do banco. Cada teste monta um opencode.db de
// mentira num diretório temporário: nada aqui toca o banco real.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenCodeHistory } from './history';

const DAY = 24 * 3600_000;
const now = 1_800_000_000_000;

interface Row {
  id: string;
  title?: string | null;
  directory?: string | null;
  created: number;
  updated: number;
}

const created: string[] = [];

/** opencode.db mínimo (só as colunas que o histórico usa) com as sessões dadas. */
function makeDb(rows: readonly Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-history-'));
  created.push(dir);
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      directory text,
      title text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      time_idle integer,
      time_archived integer,
      cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      type text NOT NULL,
      seq integer NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO session_v2 (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) insert.run(r.id, 'proj', r.directory ?? '/proj', r.title ?? null, r.created, r.updated);
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('m1', ?, 'user', 0, ?, ?, ?)",
  ).run(rows[0]?.id ?? 'ses_a', now - 1000, now - 1000, JSON.stringify({ text: 'olá' }));
  db.close();
  return path;
}

function historyOf(dbPath: string, openAgentOf: (account: string, sessionId: string) => string | undefined = () => undefined) {
  return new OpenCodeHistory({
    accounts: () => [{ id: 'opencode', dir: '/cfg' }],
    openAgentOf,
    dbPath,
    now: () => now,
  });
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('OpenCodeHistory.list', () => {
  it('lista as sessões da janela, da mais recente para a mais antiga, com título e pasta', async () => {
    const db = makeDb([
      { id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', title: 'antiga', created: now - 3 * DAY, updated: now - 2 * DAY },
      { id: 'ses_bbbbbbbbbbbbbbbbbbbbbbbb', title: 'nova', created: now - 3600_000, updated: now - 60_000 },
    ]);
    const list = await historyOf(db).list();
    expect(list.map((s) => s.sessionId)).toEqual(['ses_bbbbbbbbbbbbbbbbbbbbbbbb', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa']);
    expect(list[0]).toMatchObject({
      account: 'opencode',
      provider: 'opencode',
      title: 'nova',
      project: '/proj',
      projectDir: '/proj',
      lastAt: now - 60_000,
      firstAt: now - 3600_000,
      open: false,
    });
  });

  it('deixa de fora sessões fora dos 7 dias', async () => {
    const db = makeDb([
      { id: 'ses_velhaaaaaaaaaaaaaaaaaaa', title: 'velha', created: now - 30 * DAY, updated: now - 8 * DAY },
    ]);
    expect(await historyOf(db).list()).toEqual([]);
  });

  it('marca como aberta a sessão que o escritório conhece e preenche agentId', async () => {
    const id = 'ses_cccccccccccccccccccccccc';
    const db = makeDb([{ id, title: 'aberta', created: now - 1000, updated: now - 500 }]);
    const list = await historyOf(db, (_acc, sid) => (sid === id ? 'agent-1' : undefined)).list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ open: true, agentId: 'agent-1' });
  });

  it('ignora id em formato desconhecido (nada de path traversal)', async () => {
    const db = makeDb([{ id: '../../etc/passwd', title: 'ruim', created: now - 1000, updated: now - 500 }]);
    expect(await historyOf(db).list()).toEqual([]);
  });

  it('sem conta detectada não lista nada', async () => {
    const db = makeDb([{ id: 'ses_dddddddddddddddddddddddd', created: now - 1000, updated: now - 500 }]);
    const h = new OpenCodeHistory({ accounts: () => [], openAgentOf: () => undefined, dbPath: db, now: () => now });
    expect(await h.list()).toEqual([]);
  });

  it('banco ausente devolve lista vazia em vez de lançar', async () => {
    const h = historyOf('/caminho/que/nao/existe/opencode.db');
    expect(await h.list()).toEqual([]);
  });

  it('banco corrompido (não é SQLite) não derruba a listagem nem o resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-history-'));
    created.push(dir);
    const path = join(dir, 'opencode.db');
    writeFileSync(path, 'isto nao e um banco sqlite ' + 'x'.repeat(4096));
    const h = historyOf(path);
    expect(await h.list()).toEqual([]);
    expect(h.resolve('opencode', 'ses_aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ status: 404 });
  });

  it('respeita o limite: só as mais recentes saem', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push({ id: `ses_${String(i).padStart(24, 'a')}`, title: `t${i}`, created: now - 10_000 - i, updated: now - 1_000 - i });
    }
    const h = new OpenCodeHistory({
      accounts: () => [{ id: 'opencode', dir: '/cfg' }],
      openAgentOf: () => undefined,
      dbPath: makeDb(rows),
      now: () => now,
      limit: 3,
    });
    const list = await h.list();
    expect(list).toHaveLength(3);
    expect(list.map((s) => s.title)).toEqual(['t0', 't1', 't2']);
  });

  it('timestamps em segundos são aceitos (banco gravado em epoch seconds)', async () => {
    const secs = Math.floor(now / 1000);
    const db = makeDb([{ id: 'ses_bbbbbbbbbbbbbbbbbbbbbbbb', title: 'segundos', created: secs - 10, updated: secs - 5 }]);
    const list = await historyOf(db).list();
    expect(list).toHaveLength(1);
    expect(list[0].lastAt).toBe((secs - 5) * 1000);
  });
});

describe('OpenCodeHistory.resolve', () => {
  it('sessão existente devolve a conversa ao vivo (sem transcript em arquivo)', () => {
    const db = makeDb([{ id: 'ses_eeeeeeeeeeeeeeeeeeeeeeee', created: now - 1000, updated: now - 500 }]);
    const r = historyOf(db).resolve('opencode', 'ses_eeeeeeeeeeeeeeeeeeeeeeee');
    expect('error' in r).toBe(false);
    expect('live' in r).toBe(true);
    if (!('live' in r)) return;
    const conv = r.live();
    const { entries } = conv.load(500);
    expect(entries.map((e) => e.kind)).toContain('user');
  });

  it('id inválido é 400, conta desconhecida é 404 e sessão ausente é 404', () => {
    const db = makeDb([{ id: 'ses_ffffffffffffffffffffffff', created: now - 1000, updated: now - 500 }]);
    const h = historyOf(db);
    expect(h.resolve('opencode', '../x')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(h.resolve('outra', 'ses_ffffffffffffffffffffffff')).toMatchObject({ status: 404 });
    expect(h.resolve('opencode', 'ses_999999999999999999999999')).toMatchObject({ status: 404 });
  });
});
