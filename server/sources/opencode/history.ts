// Histórico do terminal do OpenCode (HistoryProvider 'opencode'): sessões recentes
// listadas direto do banco SQLite (~/.local/share/opencode/opencode.db). O OpenCode guarda tudo em
// session_v2 + session_message.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_DAYS, HISTORY_LIMIT } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { tr } from '../../../shared/i18n';
import {
  openCodeDbPath,
  openOpenCodeTranscriptReader,
  OpenCodeLiveConversation,
  type OpenCodeTranscriptReader,
} from './transcript';

/** Janela da listagem: a mesma do resto do Habblaud (histórico de 7 dias). */
const HISTORY_MAX_AGE_MS_OPENCODE = HISTORY_DAYS * 24 * 3600_000;
/** Sem leitor (banco ausente/ilegível): espera antes de tentar abrir de novo (o mesmo do OpenCodeSource). */
const READER_RETRY_MS = 30_000;

/**
 * O id de sessão do OpenCode é `ses_<24 chars base62>`; versões antigas usavam UUID. Aceita os dois, e nada de
 * path traversal: só letras, dígitos, `_` e `-`.
 */
const SESSION_ID_RE = /^(?:ses_[0-9A-Za-z]{16,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface OpenCodeHistoryAccount {
  id: string;
  dir: string;
}

export interface OpenCodeHistoryOptions {
  accounts: () => readonly OpenCodeHistoryAccount[];
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

interface DbLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

interface SessionRow {
  id: string;
  project_id: string;
  directory: string;
  title: string | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
  time_archived: number | null;
}

function toMs(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Segundos vs milissegundos
  if (n < 1000000000000) return n * 1000;
  return n;
}

export class OpenCodeHistory implements HistoryProvider {
  readonly provider = 'opencode' as const;
  private db: DbLike | undefined;
  private readerInstance: OpenCodeTranscriptReader | null | undefined;
  private readerRetryAt = 0;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;
  private readonly dbPath: string;

  constructor(private readonly opts: OpenCodeHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS_OPENCODE;
    this.limit = opts.limit ?? HISTORY_LIMIT;
    this.dbPath = opts.dbPath ?? openCodeDbPath(opts.env ?? process.env, opts.home);
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  private getDb(): DbLike | undefined {
    if (this.db) return this.db;
    if (!existsSync(this.dbPath)) return undefined;
    let DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DbLike;
    try {
      ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync });
    } catch {
      return undefined;
    }
    try {
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this.db;
    } catch (err) {
      log.warnOnce(`opencode-history:db:${errMsg(err)}`, tr('Histórico do OpenCode: não foi possível abrir opencode.db ({0}).', [errMsg(err)]));
      return undefined;
    }
  }

  async list(): Promise<RecentSession[]> {
    const db = this.getDb();
    if (!db) return [];
    const now = this.now();
    const cutoff = now - this.maxAgeMs;

    const sql = `
      SELECT id, project_id, directory, title, time_created, time_updated, time_idle, time_archived
      FROM session_v2
      ORDER BY time_updated DESC
      LIMIT ?
    `;
    let rows: SessionRow[] = [];
    try {
      rows = db.prepare(sql).all(this.limit * 4) as SessionRow[];
    } catch (err) {
      log.warnOnce(`opencode-history:list:${errMsg(err)}`, tr('Histórico do OpenCode: falha ao listar sessões ({0}).', [errMsg(err)]));
      return [];
    }

    const accounts = this.opts.accounts();
    if (accounts.length === 0) return [];

    const out: RecentSession[] = [];

    for (const r of rows) {
      const sessionId = r.id;
      if (!SESSION_ID_RE.test(sessionId)) continue;

      // Com mais de uma conta, a dona é a que tem a sessão aberta no escritório; senão, a primeira.
      const owner = accounts.find((a) => this.opts.openAgentOf(a.id, sessionId)) ?? accounts[0];
      const agentId = this.opts.openAgentOf(owner.id, sessionId);
      const updatedMs = toMs(r.time_updated);
      const createdMs = toMs(r.time_created);
      if (updatedMs === undefined && createdMs === undefined) continue;
      const lastAt = updatedMs ?? createdMs ?? now;
      if (lastAt < cutoff) continue;

      const firstAt = createdMs;
      const projectDir = r.directory || r.project_id || '';
      const title = r.title && r.title.trim() ? r.title.trim() : undefined;

      const s: RecentSession = {
        account: owner.id,
        provider: 'opencode',
        sessionId,
        projectDir,
        lastAt,
        size: 0,
        open: !!agentId,
      };
      if (projectDir) s.project = projectDir;
      if (title) s.title = title;
      if (firstAt !== undefined) s.firstAt = firstAt;
      if (agentId) s.agentId = agentId;
      out.push(s);
      if (out.length >= this.limit) break;
    }

    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID_RE.test(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    if (!this.hasAccount(account)) return { status: 404, error: tr('conta desconhecida') };

    const db = this.getDb();
    if (!db) return { status: 404, error: tr('sessão não encontrada') };
    let directory: string | undefined;
    try {
      const row = db.prepare('SELECT id, directory FROM session_v2 WHERE id = ?').get(sessionId) as
        | { id: string; directory?: string | null }
        | undefined;
      if (!row) return { status: 404, error: tr('sessão não encontrada') };
      directory = row.directory ?? undefined;
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }

    // O OpenCode não grava transcript por sessão: a conversa é derivada do banco a cada leitura.
    let reader: OpenCodeTranscriptReader | undefined;
    try {
      reader = this.reader();
    } catch (err) {
      log.warnOnce(`opencode-history:reader:${errMsg(err)}`, tr('Histórico do OpenCode: não foi possível ler a conversa ({0}).', [errMsg(err)]));
    }
    if (!reader) return { status: 404, error: tr('banco do OpenCode indisponível') };
    const dir = directory;
    return { live: () => new OpenCodeLiveConversation(reader, sessionId, dir) };
  }

  /**
   * Leitor do banco (uma instância por provedor; o terminal pede uma conversa nova a cada conexão). Sem banco ou
   * banco ilegível: undefined, e tenta de novo depois de READER_RETRY_MS — a falha não fica gravada para sempre.
   */
  private reader(): OpenCodeTranscriptReader | undefined {
    if (this.readerInstance) return this.readerInstance;
    if (this.readerInstance === null && this.now() < this.readerRetryAt) return undefined;
    let created: OpenCodeTranscriptReader | undefined;
    try {
      created = openOpenCodeTranscriptReader(this.dbPath);
    } catch (err) {
      log.warnOnce(`opencode-history:db:${errMsg(err)}`, tr('Histórico do OpenCode: não foi possível abrir opencode.db ({0}).', [errMsg(err)]));
    }
    this.readerInstance = created ?? null;
    if (!this.readerInstance) this.readerRetryAt = this.now() + READER_RETRY_MS;
    return created;
  }

  close(): void {
    try {
      this.readerInstance?.close();
    } catch {}
    this.readerInstance = undefined;
    try {
      this.db?.close();
    } catch {}
    this.db = undefined;
  }
}
