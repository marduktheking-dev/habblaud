// Mapeamento da conversa do OpenCode (session_message) para as entradas do terminal. Puro: nada de SQLite aqui — as
// linhas são montadas à mão, no formato real do banco.
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { mapMessages, openCodeDbPath, openOpenCodeTranscriptReader, tasksFromMessage, type OpenCodeMessage } from './transcript';

type Rec = Record<string, unknown>;

function msg(seq: number, type: string, data: Rec, id = `m${seq}`): OpenCodeMessage {
  return { id, type, seq, at: 1_000 + seq, data };
}

/** Mensagem do assistente com `content` (o `time.completed` marca o passo como terminado). */
function assistant(seq: number, content: unknown[], opts: { completed?: boolean; id?: string } = {}): OpenCodeMessage {
  const time: Rec = { created: 1_000 + seq };
  if (opts.completed !== false) time.completed = 1_000 + seq + 10;
  return msg(seq, 'assistant', { time, agent: 'build', model: { id: 'x', providerID: 'opencode' }, content }, opts.id);
}

function toolPart(name: string, state: Rec): Rec {
  return { type: 'tool', id: `call_${name}`, name, state };
}

const kinds = (entries: readonly TerminalEntry[]) => entries.map((e) => e.kind);

describe('mapMessages: prompts e respostas', () => {
  it('prompt do usuário vira uma entrada user com o id da mensagem', () => {
    const entries = mapMessages([msg(4, 'user', { time: { created: 1_004 }, text: 'qual o comando?', files: [], agents: [] })]);
    expect(entries).toEqual([{ kind: 'user', id: 'm4:u', at: 1_004, text: 'qual o comando?' }]);
  });

  it('texto e raciocínio saem só depois de o passo terminar (nada de texto parcial)', () => {
    const content: unknown[] = [
      { type: 'reasoning', text: 'pensando', time: { created: 1, completed: 2 } },
      { type: 'text', text: 'Pronto.' },
    ];
    const done = mapMessages([assistant(5, content)]);
    expect(done.map((e) => e.kind)).toEqual(['thinking', 'assistant']);
    expect(done[0]).toMatchObject({ id: 'm5:k0', text: 'pensando' });
    expect(done[1]).toMatchObject({ id: 'm5:t1', text: 'Pronto.' });

    // Ainda chegando: nada de texto (uma entrada acrescentada não daria para atualizar).
    expect(mapMessages([assistant(5, content, { completed: false })])).toEqual([]);
  });
});

describe('mapMessages: ferramentas', () => {
  it('ferramenta concluída: entrada tool (nome do Claude Code) + result pelo toolUseId', () => {
    const rows = [
      assistant(5, [
        { type: 'reasoning', text: 'vou ler', time: { created: 5, completed: 6 } },
        toolPart('read', { status: 'completed', input: { path: '/proj/a.ts' }, content: [{ type: 'text', text: 'linha 1\nlinha 2' }], time: { created: 7, completed: 8 } }),
      ]),
    ];
    const entries = mapMessages(rows, '/proj');
    expect(kinds(entries)).toEqual(['thinking', 'tool', 'result']);
    expect(entries[1]).toMatchObject({ kind: 'tool', id: 'call_read', tool: 'Read', title: 'Read(a.ts)', at: 7 });
    expect(entries[2]).toMatchObject({ kind: 'result', id: 'call_read:r', toolUseId: 'call_read', text: 'linha 1\nlinha 2' });
  });

  it('ferramenta rodando: só a entrada tool, sem resultado ainda', () => {
    const rows = [assistant(5, [toolPart('shell', { status: 'running', input: { command: 'sleep 300' } })])];
    const entries = mapMessages(rows);
    expect(kinds(entries)).toEqual(['tool']);
    expect(entries[0]).toMatchObject({ tool: 'Bash', title: 'Bash(sleep 300)', input: 'sleep 300', inputKind: 'command' });
  });

  it('ferramenta com erro: resultado marcado, com a mensagem do erro', () => {
    const rows = [
      assistant(5, [toolPart('read', { status: 'error', input: { path: '/x' }, error: { type: 'tool.execution', message: 'File not found: /x' } })]),
    ];
    const entries = mapMessages(rows);
    expect(entries[1]).toMatchObject({ kind: 'result', error: true, text: 'File not found: /x' });
  });

  it('edit vira um diff com os caminhos encurtados pela pasta do projeto', () => {
    const rows = [assistant(5, [toolPart('edit', { status: 'completed', input: { path: '/proj/src/a.ts', oldString: 'antigo', newString: 'novo' }, content: [{ type: 'text', text: 'ok' }] })])];
    const entries = mapMessages(rows, '/proj');
    expect(entries[0]).toMatchObject({ tool: 'Edit', title: 'Edit(src/a.ts)', inputKind: 'diff' });
    if (entries[0].kind !== 'tool') throw new Error('esperado entrada tool');
    expect(entries[0].input).toContain('- antigo');
    expect(entries[0].input).toContain('+ novo');
  });

  it('execute (código) usa o mesmo visual do Bash', () => {
    const rows = [assistant(5, [toolPart('execute', { status: 'completed', input: { code: 'echo oi' }, content: [{ type: 'text', text: 'oi' }] })])];
    expect(mapMessages(rows)[0]).toMatchObject({ tool: 'Bash', title: 'Bash(echo oi)' });
  });

  it('ferramenta desconhecida mantém o nome bruto e não inventa argumentos', () => {
    const rows = [assistant(5, [toolPart('alguma_coisa', { status: 'completed', input: { a: 1 }, content: [{ type: 'text', text: 'ok' }] })])];
    const e = mapMessages(rows)[0];
    expect(e).toMatchObject({ tool: 'alguma_coisa' });
    if (e.kind !== 'tool') throw new Error('esperado entrada tool');
    expect(e.title).toContain('alguma_coisa');
  });
});

describe('mapMessages: eventos e ruído', () => {
  it('compaction vira um aviso; falha fica como warn com o motivo', () => {
    const ok = mapMessages([msg(10, 'compaction', { time: { created: 1_010 }, status: 'completed', reason: 'auto' })]);
    expect(ok[0]).toMatchObject({ kind: 'system', level: 'info', text: 'Conversa compactada automaticamente' });
    const failed = mapMessages([msg(11, 'compaction', { time: { created: 1_011 }, status: 'failed', reason: 'auto', error: { type: 'compaction.interrupted', message: 'Compaction was interrupted' } })]);
    expect(failed[0]).toMatchObject({ kind: 'system', level: 'warn', text: 'Falha ao compactar a conversa' });
    if (failed[0].kind !== 'system') throw new Error('esperado entrada system');
    expect(failed[0].detail).toBe('Compaction was interrupted');
  });

  it('synthetic (aviso do servidor) aparece como system; instruções e idle/agent-switched não', () => {
    const rows = [
      msg(1, 'idle', { time: { created: 1_001 }, outcome: 'succeeded' }),
      msg(2, 'agent-switched', { time: { created: 1_002 }, agent: 'build', previous: 'build' }),
      msg(3, 'system', { time: { created: 1_003 }, metadata: { notice: 'instructions' }, text: 'New skills are available...' }),
      msg(12, 'synthetic', { time: { created: 1_012 }, metadata: { notice: 'restart' }, text: 'The server restarted while you were working.', description: 'Continuing after restart' }),
    ];
    const entries = mapMessages(rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'system', id: 'm12:s', at: 1_012, text: 'The server restarted while you were working.' });
  });
});

describe('openCodeDbPath', () => {
  it('usa o data dir do OpenCode, com XDG e HABBLAUD_OPENCODE_DB', () => {
    expect(openCodeDbPath({}, '/h')).toBe('/h/.local/share/opencode/opencode.db');
    expect(openCodeDbPath({ XDG_DATA_HOME: '/data' }, '/h')).toBe('/data/opencode/opencode.db');
    expect(openCodeDbPath({ HABBLAUD_OPENCODE_DB: '/mnt/opencode.db' }, '/h')).toBe('/mnt/opencode.db');
  });
});

describe('tasksFromMessage', () => {
  const todo = (todos: unknown) => ({ content: [{ type: 'text', text: 'oi' }, { type: 'tool', name: 'todowrite', state: { input: { todos } } }] });

  it('tira as tarefas da última lista todo/todowrite da mensagem', () => {
    const data = { content: [...(todo([{ id: '1', content: 'Antiga', status: 'pending' }]).content as unknown[]), { type: 'tool', name: 'todowrite', state: { input: { todos: [{ id: '2', content: 'Arrumar o login', status: 'in_progress', activeForm: 'Arrumando o login' }] } } }] };
    expect(tasksFromMessage(data)).toEqual([{ id: '2', title: 'Arrumar o login', status: 'in_progress', activeForm: 'Arrumando o login' }]);
  });

  it('sem ferramenta de tarefas (ou sem lista) não inventa nada', () => {
    expect(tasksFromMessage({ content: [{ type: 'tool', name: 'shell', state: { input: { command: 'ls' } } }] })).toEqual([]);
    expect(tasksFromMessage({ content: [{ type: 'tool', name: 'todowrite', state: {} }] })).toEqual([]);
    expect(tasksFromMessage(undefined)).toEqual([]);
    expect(tasksFromMessage({ content: 'nada' })).toEqual([]);
  });
});

/** O `node:sqlite` não existe em todo Node (e é experimental): sem ele, o leitor real não é testado aqui. */
const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb };
  } catch {
    return undefined;
  }
})();

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

describe.skipIf(!sqlite)('openOpenCodeTranscriptReader: o banco de verdade', () => {
  it('soma o raciocínio na saída e traz título e tarefas do banco', () => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-oc-db-'));
    const dbPath = join(dir, 'opencode.db');
    try {
      const db = new sqlite!.DatabaseSync(dbPath);
      db.exec('CREATE TABLE session_v2 (id TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, title TEXT)');
      db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)');
      db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('ses_1', 0.5, 100, 40, 7, 10, 5, 'Comando para iniciar a estação');
      const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('m1', 'ses_1', 'user', 1, 1_000, JSON.stringify({ text: 'oi' }));
      insert.run('m2', 'ses_1', 'assistant', 2, 2_000, JSON.stringify({ content: [{ type: 'tool', name: 'shell', state: { input: { command: 'ls' } } }] }));
      insert.run('m3', 'ses_1', 'assistant', 3, 3_000, JSON.stringify({ content: [{ type: 'tool', name: 'todowrite', state: { input: { todos: [{ id: '1', content: 'Arrumar o login', status: 'completed' }] } } }] }));
      db.close();

      const reader = openOpenCodeTranscriptReader(dbPath);
      expect(reader).toBeDefined();
      expect(reader!.totals('ses_1')).toMatchObject({
        toolCalls: 2,
        tokensIn: 115,
        tokensOut: 47, // 40 de saída + 7 de raciocínio
        costUSD: 0.5,
        title: 'Comando para iniciar a estação',
        tasks: [{ id: '1', title: 'Arrumar o login', status: 'completed' }],
      });
      expect(reader!.totals('ses_inexistente')).toBeUndefined();
      reader!.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
