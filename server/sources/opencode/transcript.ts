// Conversa de uma sessão do OpenCode lida do banco (opencode.db) para o terminal ao vivo.
//
// Por que o banco e não um arquivo: o OpenCode não grava um transcript JSONL por sessão como o Claude Code e o Codex;
// ele guarda a sessão inteira em SQLite (tabela session_message, uma linha por mensagem, com o conteúdo em JSON).
// O plugin local (mod/habblaud-opencode) manda só ids e nomes de ferramenta — nunca o texto — então, para mostrar a
// conversa, a única fonte real é o banco.
//
// Privacidade: a leitura é SOMENTE de leitura (`readOnly`) e só existe com o Habblaud no acesso local
// (bind 127.0.0.1), pela mesma trava que já protege a conversa das outras ferramentas. A CONVERSA só é lida com o
// terminal ligado; os totais do agente (tokens, custo, ferramentas) e o que o banco já sabe dele (o título automático
// e a lista de tarefas) são lidos também para a gaveta do agente. Nada é copiado para ~/.habblaud: as entradas são
// derivadas em memória a cada leitura.
//
// Este arquivo tem duas partes independentes: o mapeamento puro das linhas para TerminalEntry (mapMessages, testável
// sem banco) e o leitor do SQLite (openOpenCodeTranscriptReader), que os testes injetam por uma interface.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { TaskItem, TerminalEntry, TerminalInputKind } from '../../../shared/types';
import type { LiveConversation } from '../source';
import { maskSecrets } from '../../../shared/activity';
import { marked, prepare, toolView, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX } from '../terminal';
import { todosToTasks } from '../transcript';
import { opencodeDataDir } from './accounts';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

/** Janela relida do fim a cada ciclo (a última mensagem muda no lugar enquanto o agente escreve). */
const LIVE_TAIL_ROWS = 12;
/** Mensagens lidas para o `init` do terminal (as mais recentes). */
const LIVE_LOAD_ROWS = 400;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ------------------------------------------------------------------ caminho do banco

/**
 * Caminho do banco do OpenCode: HABBLAUD_OPENCODE_DB (arquivo completo, útil no Docker com o data dir montado) ou
 * <data dir>/opencode.db (~/.local/share/opencode/opencode.db).
 */
export function openCodeDbPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const override = env.HABBLAUD_OPENCODE_DB?.trim();
  return override || join(opencodeDataDir(env, home), 'opencode.db');
}

// ------------------------------------------------------------------ linhas do banco

/** Uma linha de session_message já interpretada (o `data` é o JSON da mensagem). */
export interface OpenCodeMessage {
  id: string;
  type: string;
  seq: number;
  at: number;
  data: Rec;
}

/** Totais acumulados de uma sessão (session_v2 + contagem de ferramentas), com o que mais o banco já sabe. */
export interface OpenCodeTotals {
  toolCalls: number;
  /** input + cache de leitura + cache de escrita. */
  tokensIn: number;
  /** Saída + raciocínio: o OpenCode guarda o raciocínio numa coluna própria (tokens_reasoning), mas ele é saída. */
  tokensOut: number;
  costUSD?: number;
  /** Título da sessão no banco. É a única forma de saber o título AUTOMÁTICO: ele não tem evento de renome. */
  title?: string;
  /** Tarefas do agente: a última lista da ferramenta todo/todowrite, se ele já usou uma. */
  tasks?: TaskItem[];
}

/** Leitura do banco do OpenCode. Os testes injetam uma implementação sem SQLite. */
export interface OpenCodeTranscriptReader {
  /** Últimas `limit` mensagens, em ordem crescente de seq; `more` = havia mais antes delas. */
  recent(sessionId: string, limit: number): { rows: OpenCodeMessage[]; more: boolean };
  /** Mensagens com seq >= `seq`, em ordem crescente (a última linha pode ter mudado no lugar). */
  since(sessionId: string, seq: number): OpenCodeMessage[];
  /** Totais da sessão, ou undefined se a sessão não existe. */
  totals(sessionId: string): OpenCodeTotals | undefined;
  close(): void;
}

/** Nome da ferramenta do OpenCode -> nome no estilo do Claude Code (o mesmo que toolView espera). */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  patch: 'Edit',
  shell: 'Bash',
  bash: 'Bash',
  execute: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'LS',
  list: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  skill: 'Skill',
  question: 'AskUserQuestion',
  todo: 'TodoWrite',
  todowrite: 'TodoWrite',
  task: 'Task',
};

/** Argumentos do OpenCode -> chaves que toolView entende (file_path/old_string/command...), sem inventar nada. */
function toolInput(name: string, input: Rec): Rec {
  const s = (k: string) => str(input[k]);
  const keep = (keys: readonly string[]): Rec => {
    const out: Rec = {};
    for (const k of keys) if (input[k] !== undefined && input[k] !== null) out[k] = input[k];
    return out;
  };
  switch (name) {
    case 'read':
      return { file_path: s('path') };
    case 'write': {
      const out: Rec = { file_path: s('path') };
      if (input.content !== undefined) out.content = input.content;
      return out;
    }
    case 'edit':
    case 'patch': {
      const out: Rec = { file_path: s('path') ?? s('filePath') };
      if (input.oldString !== undefined) out.old_string = input.oldString;
      if (input.newString !== undefined) out.new_string = input.newString;
      return out;
    }
    case 'shell':
    case 'bash':
      return { command: s('command') };
    case 'execute':
      return { command: s('code') };
    case 'grep':
      return { pattern: s('pattern'), ...(s('path') ? { path: s('path') } : {}) };
    case 'glob':
      return { pattern: s('pattern'), ...(s('path') ? { path: s('path') } : {}) };
    case 'webfetch':
      return { url: s('url'), ...(s('format') ? { prompt: s('format') } : {}) };
    case 'websearch':
      return { query: s('query') };
    case 'skill':
      return { skill: s('id') ?? s('skill') };
    case 'question':
      return keep(['questions']);
    case 'todo':
    case 'todowrite':
      return keep(['todos']);
    case 'task':
      return { subagent_type: s('agent') ?? s('subagent_type'), ...(s('description') ? { description: s('description') } : {}), ...(s('prompt') ? { prompt: s('prompt') } : {}) };
    default:
      return input;
  }
}

/** Timestamp de uma ferramenta: o do próprio estado, caindo para o da mensagem. */
function toolAt(state: Rec, fallback: number): number {
  const t = rec(state.time);
  return num(t?.created) ?? num(t?.ran) ?? num(t?.completed) ?? fallback;
}

/** Texto de `state.content` (blocos de texto; imagem/documento viram marcadores, como no Claude Code). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    const b = rec(raw);
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push(tr('[imagem]'));
    else if (b.type === 'document') parts.push('[documento]');
  }
  return parts.join('\n');
}

/**
 * Converte as mensagens de uma sessão em entradas do terminal, na mesma forma do Claude Code. Puro: os testes cobrem
 * o formato sem abrir o banco. `cwd` só serve para encurtar caminhos no título das ferramentas.
 */
export function mapMessages(rows: readonly OpenCodeMessage[], cwd?: string): TerminalEntry[] {
  const out: TerminalEntry[] = [];
  for (const row of rows) {
    switch (row.type) {
      case 'user': {
        const text = str(row.data.text);
        const t = text ? marked(prepare(text, TEXT_MAX)) : '';
        if (t) out.push({ kind: 'user', id: `${row.id}:u`, at: row.at, text: t });
        break;
      }
      case 'assistant':
        assistantEntries(row, out, cwd);
        break;
      case 'compaction':
        compactionEntry(row, out);
        break;
      case 'synthetic':
        systemEntry(row, out);
        break;
      case 'system':
        // Avisos de instruções do próprio OpenCode (catálogo de skills...) são ruído para a conversa.
        if (str(rec(row.data.metadata)?.notice) !== 'instructions') systemEntry(row, out);
        break;
      default:
        // idle, agent-switched, model-switched: sem nada para mostrar.
        break;
    }
  }
  return out;
}

/**
 * Uma mensagem do assistente: `text`/`reasoning` só depois de o passo terminar (um texto que ainda está chegando não
 * daria para atualizar numa entrada acrescentada); as ferramentas saem assim que aparecem, com o resultado quando o
 * estado deixa de ser 'running'.
 */
function assistantEntries(row: OpenCodeMessage, out: TerminalEntry[], cwd: string | undefined): void {
  const done = num(rec(row.data.time)?.completed) !== undefined;
  const content = Array.isArray(row.data.content) ? row.data.content : [];
  content.forEach((raw, i) => {
    const p = rec(raw);
    if (!p) return;
    if (p.type === 'tool') {
      toolEntries(row, p, out, cwd, i);
      return;
    }
    if (!done) return;
    if (p.type === 'reasoning') {
      const e: TerminalEntry = { kind: 'thinking', id: `${row.id}:k${i}`, at: row.at };
      const text = typeof p.text === 'string' ? p.text : '';
      if (text.trim()) {
        const t = marked(prepare(text, THINKING_MAX));
        if (t) e.text = t;
      }
      out.push(e);
      return;
    }
    if (p.type === 'text') {
      const text = typeof p.text === 'string' ? p.text : '';
      const t = marked(prepare(text, TEXT_MAX));
      if (t) out.push({ kind: 'assistant', id: `${row.id}:t${i}`, at: row.at, text: t });
    }
  });
}

/** Ferramenta + resultado. O id do tool_use é o do OpenCode; o resultado aponta de volta por `toolUseId`. */
function toolEntries(row: OpenCodeMessage, p: Rec, out: TerminalEntry[], cwd: string | undefined, index: number): void {
  const id = str(p.id) ?? `${row.id}:x${index}`;
  const state = rec(p.state) ?? {};
  const input = rec(state.input) ?? {};
  const rawName = str(p.name) ?? 'ferramenta';
  const key = rawName.toLowerCase();
  const name = TOOL_NAMES[key] ?? rawName;
  const view = toolView(name, toolInput(key, input), cwd);
  const at = toolAt(state, row.at);
  const tool: TerminalEntry = { kind: 'tool', id, at, tool: name, title: maskSecrets(view.title) };
  if (view.input) {
    tool.input = view.input;
    tool.inputKind = view.inputKind as TerminalInputKind;
  }
  out.push(tool);

  const status = str(state.status);
  if (status === 'running') return;
  const error = status === 'error';
  const raw = error ? str(rec(state.error)?.message) ?? tr('(falhou)') : toolResultText(state.content);
  const prepared = prepare(raw, RESULT_MAX, RESULT_MAX_LINES);
  const result: TerminalEntry = { kind: 'result', id: `${id}:r`, at, toolUseId: id, text: prepared.text || tr('(sem saída)') };
  if (error) result.error = true;
  if (prepared.truncated) result.truncated = true;
  out.push(result);
}

function compactionEntry(row: OpenCodeMessage, out: TerminalEntry[]): void {
  const failed = str(row.data.status) === 'failed';
  const reason = str(row.data.reason);
  const text = failed
    ? tr('Falha ao compactar a conversa')
    : reason === 'auto'
      ? tr('Conversa compactada automaticamente')
      : tr('Conversa compactada');
  const e: TerminalEntry = { kind: 'system', id: `${row.id}:s`, at: row.at, text, level: failed ? 'warn' : 'info' };
  const detail = failed ? str(rec(row.data.error)?.message) : undefined;
  if (detail) {
    const d = marked(prepare(detail, RESULT_MAX));
    if (d) e.detail = d;
  }
  out.push(e);
}

/** Aviso do sistema (texto livre): a primeira linha no rótulo e o resto no detalhe. */
function systemEntry(row: OpenCodeMessage, out: TerminalEntry[]): void {
  const text = str(row.data.text);
  if (!text) return;
  const prepared = prepare(text, RESULT_MAX);
  const first = prepared.text.split('\n').find((l) => l.trim()) ?? '';
  if (!first) return;
  const e: TerminalEntry = { kind: 'system', id: `${row.id}:s`, at: row.at, text: maskSecrets(first) };
  if (prepared.text.trim() !== first.trim()) e.detail = prepared.text;
  out.push(e);
}

/**
 * Tarefas do agente a partir do `data` de uma mensagem do assistente: vale a última ferramenta todo/todowrite da
 * mensagem (o OpenCode atualiza a lista inteira a cada chamada). Puro, para os testes cobrirem a forma real.
 */
export function tasksFromMessage(data: unknown): TaskItem[] {
  const content = Array.isArray(rec(data)?.content) ? (rec(data)?.content as unknown[]) : [];
  for (let i = content.length - 1; i >= 0; i--) {
    const part = rec(content[i]);
    if (!part || part.type !== 'tool') continue;
    const name = str(part.name)?.toLowerCase();
    if (name !== 'todo' && name !== 'todowrite') continue;
    return todosToTasks(rec(rec(part.state)?.input)?.todos);
  }
  return [];
}

// ------------------------------------------------------------------ leitor do SQLite

const SELECT_RECENT = 'SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ?';
const SELECT_SINCE = 'SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? AND seq >= ? ORDER BY seq';
const SELECT_SESSION = 'SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, title FROM session_v2 WHERE id = ?';
const COUNT_TOOLS =
  "SELECT count(*) AS c FROM session_message m, json_each(m.data, '$.content') WHERE m.session_id = ? AND m.type = 'assistant' AND json_extract(json_each.value, '$.type') = 'tool'";
const SELECT_TODOS =
  "SELECT m.data AS data FROM session_message m, json_each(m.data, '$.content') WHERE m.session_id = ? AND m.type = 'assistant' AND json_extract(json_each.value, '$.type') = 'tool' AND lower(json_extract(json_each.value, '$.name')) IN ('todo', 'todowrite') ORDER BY m.seq DESC LIMIT 1";

interface RawRow {
  id: string;
  type: string;
  seq: number;
  time_created: number;
  data: string;
}

function toMessage(r: RawRow): OpenCodeMessage {
  let data: Rec = {};
  try {
    data = rec(JSON.parse(r.data)) ?? {};
  } catch {
    data = {};
  }
  return { id: r.id, type: r.type, seq: Number(r.seq), at: Number(r.time_created), data };
}

/**
 * Abre o banco do OpenCode em modo SOMENTE LEITURA. Devolve undefined se o arquivo não existe ou se o `node:sqlite`
 * não está disponível (Node antigo): aí não há terminal do OpenCode, mas o resto do Habblaud segue.
 */
export function openOpenCodeTranscriptReader(dbPath: string): OpenCodeTranscriptReader | undefined {
  if (!existsSync(dbPath)) return undefined;
  let DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DbLike;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync });
  } catch {
    return undefined;
  }
  // Banco corrompido, schema antigo ou permissão negada: fecha o que foi aberto e devolve undefined
  // (nunca lança — resolve() promete 400/404 e a rota não tem try/catch).
  let db: DbLike | undefined;
  let stRecent: PStmt;
  let stSince: PStmt;
  let stSession: PStmt;
  let stTools: PStmt;
  let stTodos: PStmt;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    stRecent = db.prepare(SELECT_RECENT);
    stSince = db.prepare(SELECT_SINCE);
    stSession = db.prepare(SELECT_SESSION);
    stTools = db.prepare(COUNT_TOOLS);
    stTodos = db.prepare(SELECT_TODOS);
  } catch {
    try {
      db?.close();
    } catch {}
    return undefined;
  }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  return {
    recent(sessionId, limit) {
      const raw = stRecent.all(sessionId, limit + 1) as unknown as RawRow[];
      const more = raw.length > limit;
      const rows = raw.slice(0, limit).reverse().map(toMessage);
      return { rows, more };
    },
    since(sessionId, seq) {
      return (stSince.all(sessionId, seq) as unknown as RawRow[]).map(toMessage);
    },
    totals(sessionId) {
      const s = stSession.get(sessionId) as Record<string, unknown> | undefined;
      if (!s) return undefined;
      const toolCalls = n((stTools.get(sessionId) as { c?: unknown } | undefined)?.c);
      const cost = num(s.cost);
      const totals: OpenCodeTotals = {
        toolCalls,
        tokensIn: n(s.tokens_input) + n(s.tokens_cache_read) + n(s.tokens_cache_write),
        tokensOut: n(s.tokens_output) + n(s.tokens_reasoning),
        tasks: [],
      };
      if (cost !== undefined) totals.costUSD = cost;
      const title = str(s.title);
      if (title) totals.title = title;
      const todos = stTodos.get(sessionId) as { data?: unknown } | undefined;
      if (todos) {
        try {
          totals.tasks = tasksFromMessage(JSON.parse(String(todos.data)));
        } catch {
          /* linha ilegível: fica sem tarefas, como se não houvesse lista */
        }
      }
      return totals;
    },
    close() {
      db?.close();
    },
  };
}

/** Mínimo do DatabaseSync que usamos (evita depender dos tipos experimentais do node:sqlite). */
interface DbLike {
  prepare(sql: string): PStmt;
  close(): void;
}

/** Mínimo do statement preparado que usamos. */
interface PStmt {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/**
 * Conversa de uma sessão do OpenCode para o terminal, derivada do banco a cada leitura (nada copiado para disco).
 * Guarda o que já foi entregue e o último seq lido: como a última mensagem é atualizada NO LUGAR enquanto o agente
 * escreve (texto chegando, ferramenta concluindo), cada ciclo relê uma janela do fim e devolve só o que é novo.
 */
export class OpenCodeLiveConversation implements LiveConversation {
  private readonly sent = new Set<string>();
  private lastSeq = -1;

  constructor(
    private readonly reader: OpenCodeTranscriptReader,
    private readonly sessionId: string,
    private readonly cwd: string | undefined,
  ) {}

  load(limit: number): { entries: TerminalEntry[]; truncated: boolean } {
    const { rows, more } = this.reader.recent(this.sessionId, LIVE_LOAD_ROWS);
    const all = mapMessages(rows, this.cwd);
    this.sent.clear();
    for (const e of all) this.sent.add(e.id);
    if (rows.length) this.lastSeq = rows[rows.length - 1].seq;
    const entries = all.slice(-limit);
    return { entries, truncated: more || entries.length < all.length };
  }

  poll(): TerminalEntry[] {
    if (this.lastSeq < 0) return [];
    const from = Math.max(0, this.lastSeq - LIVE_TAIL_ROWS + 1);
    const rows = this.reader.since(this.sessionId, from);
    if (!rows.length) return [];
    const last = rows[rows.length - 1].seq;
    if (last > this.lastSeq) this.lastSeq = last;
    const fresh: TerminalEntry[] = [];
    for (const e of mapMessages(rows, this.cwd)) {
      if (this.sent.has(e.id)) continue;
      this.sent.add(e.id);
      fresh.push(e);
    }
    return fresh;
  }
}
