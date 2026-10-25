// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts). Quem conta o que está acontecendo é
// o plugin local do OpenCode (~/.config/opencode/plugins/habblaud-events.ts): ele observa os eventos reais da sessão
// e manda um pacote normalizado para POST /api/opencode/events, que chega aqui por applyEvent (OpenCodeLive).
//
// Por que o plugin e não os arquivos: o OpenCode guarda as sessões num banco (opencode.db), e uma sessão no banco
// NÃO quer dizer sessão aberta. Presença e atividade saem só dos eventos ao vivo — nada de banco, nada inventado.
//
// Presença (bounded window, sem sinal de vida incondicional): o processo do plugin (`opencode serve`) sobrevive às
// telas, então um heartbeat genérico manteria sessões fantasmas. Em vez disso:
// - cada evento aceito renova `lastEventAt` (relógio do servidor); o plugin ainda manda um `session.ping` espaçado
//   (1 a cada 10 s) nos eventos que o escritório ignora (texto, raciocínio...), mantendo um turno longo e calado vivo;
// - `session.turn.start`/`session.step`/`tool.start` deixam o agente 'working'; `session.turn.end` volta a 'idle';
// - `session.compact` e `session.retry` viram atividade (compactando a memória / tentando de novo) e `session.usage`
//   avisa que o banco tem números novos: aí título, tarefas e totais são relidos na hora, sem esperar a validade;
// - uma ferramenta em voo (`tool.start` sem `tool.end`) segura a presença por até OPENCODE_TOOL_MAX_MS, para uma
//   rodada longa (um build de minutos) não sumir — foi o que a medição real mostrou (até ~4 min sem nenhum evento);
// - sem evento por OPENCODE_PRESENCE_MS a sessão sai do escritório; 'working' calado por OPENCODE_WORKING_QUIET_MS e
//   sem ferramenta rodando volta a 'idle' (turno morto). `session.delete` fecha na hora.
//
// Como o OpenCode não tem um "encerrou a janela" confiável (não há evento de desconexão por tela), uma sessão ociosa
// e esquecida também sai depois da janela — o mesmo limite conhecido do Codex com sessões esquecidas. Nada de estado
// de permissão inventado: só o que o plugin mandar vira status.
import type { AgentStatus, SourceInfo, TerminalEntry } from '../../../shared/types';
import { SPECIAL } from '../../../shared/activity';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource, LiveConversation } from '../source';
import { describeOpenCodeTool } from './activity';
import { detectOpenCodeAccounts } from './accounts';
import type { OpenCodeLive } from './live';
import { mapMessages, openCodeDbPath, openOpenCodeTranscriptReader, OpenCodeLiveConversation, type OpenCodeTotals, type OpenCodeTranscriptReader } from './transcript';
import { tr } from '../../../shared/i18n';

/** Sem evento por este tempo (e sem ferramenta rodando): a sessão sai do escritório. */
export const OPENCODE_PRESENCE_MS = 5 * 60_000;
/** 'working', calado e sem ferramenta rodando por este tempo: o turno morreu (crash): vira 'idle'. */
export const OPENCODE_WORKING_QUIET_MS = 2 * 60_000;
/** Uma ferramenta em voo segura a presença por até este tempo (uma rodada longa pode ficar minutos calada). */
export const OPENCODE_TOOL_MAX_MS = 30 * 60_000;
/** De quanto em quanto tempo revisar as sessões expiradas. */
export const OPENCODE_SWEEP_MS = 5_000;
/** Quanto os totais da sessão (tokens, custo, ferramentas) podem ficar velhos antes de reler o banco. */
export const OPENCODE_TOTALS_MS = 10_000;
/** Um evento de uso pede números frescos, mas no máximo a cada isto (cada releitura é uma consulta ao banco). */
export const OPENCODE_USAGE_MS = 2_000;
/** Retentativa da API vira atividade no máximo a cada isto: uma sequência de tentativas não inunda o escritório. */
export const OPENCODE_RETRY_QUIET_MS = 60_000;
/** Sem banco (ou Node antigo): espera antes de tentar abrir de novo. */
const READER_RETRY_MS = 30_000;
/** Quantos ids de evento lembrar para não aplicar o mesmo duas vezes (várias instâncias do plugin repetem). */
const SEEN_MAX = 2_000;
const MAIN_ROLE = tr('Agente principal (OpenCode)');
const SUB_ROLE = tr('Subagente (OpenCode)');

/** Tipos de evento que a fonte entende (o resto é ignorado: `ok: false`, sem inventar nada). */
const EVENT_TYPES = new Set([
  'session.create',
  'session.rename',
  'session.model',
  'session.agent',
  'session.move',
  'session.turn.start',
  'session.step',
  'session.turn.end',
  'session.status',
  'session.permission',
  'session.error',
  'session.ping',
  'session.delete',
  'tool.start',
  'tool.end',
  'session.usage',
  'session.retry',
  'session.compact',
]);

/**
 * Prefixo das sessões de SHELL do OpenCode (`sh_...`): cada comando do terminal vira uma sessão dessas, que não é
 * uma pessoa trabalhando. Ficam de fora aqui também (e não só no plugin) porque um plugin antigo pode continuar
 * anunciando-as — e o escritório não deve encher de bonecos fantasma por causa disso.
 */
const SHELL_SESSION_PREFIX = 'sh_';

type Rec = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function envMs(env: NodeJS.ProcessEnv | undefined, name: string, fallback: number): number {
  const raw = env?.[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface OpenCodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do OpenCode lidas por este processo (no Docker, as montadas), uma por conta. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  /** Janela de presença (padrão OPENCODE_PRESENCE_MS; HABBLAUD_OPENCODE_PRESENCE_MS). */
  presenceMs?: number;
  /** 'working' calado vira 'idle' (padrão OPENCODE_WORKING_QUIET_MS; HABBLAUD_OPENCODE_QUIET_MS). */
  workingQuietMs?: number;
  /** Uma ferramenta em voo segura a presença até isto (padrão OPENCODE_TOOL_MAX_MS; HABBLAUD_OPENCODE_TOOL_MAX_MS). */
  toolMaxMs?: number;
  /** Intervalo da varredura (padrão OPENCODE_SWEEP_MS). */
  sweepMs?: number;
  /** Ids de evento lembrados para deduplicar (padrão 2000). */
  seenMax?: number;
  /**
   * Leitor do banco do OpenCode (terminal ao vivo e totais); padrão: abre o opencode.db em modo somente leitura.
   * Os testes injetam uma implementação sem SQLite.
   */
  transcriptReader?: () => OpenCodeTranscriptReader | undefined;
}

interface OpenCodeAccount {
  id: string;
  /** Pasta lida por este processo. */
  dir: string;
  /** Pasta para exibir (no Docker, a do host). */
  configDir: string;
}

interface SessionTracker {
  key: string;
  acc: OpenCodeAccount;
  sessionId: string;
  /** main/sub pelo parentID do session.created; subs só entram com o pai presente. */
  kind: 'main' | 'sub';
  parentSessionId?: string;
  /** Pasta do projeto (a sala); sem ela o agente não entra no escritório. */
  directory?: string;
  title?: string;
  agent?: string;
  model?: string;
  status: AgentStatus;
  /** Quando o status foi decidido (linha do evento): informação mais velha não o muda. */
  statusAt: number;
  waitingFor?: string;
  inOffice: boolean;
  startedAt: number;
  /** Relógio do servidor do último evento aceito (base da presença). */
  lastEventAt: number;
  /** Ferramenta em voo (tool.start sem tool.end): segura a presença de uma rodada longa. */
  toolRun?: { at: number };
  /** Última retentativa da API mostrada (evita encher o escritório numa sequência de tentativas). */
  lastRetryAt?: number;
  /** Subagente que já entregou (status 'done'). */
  subDone: boolean;
  /** Subagente que já trabalhou ao menos uma vez (só então 'idle' vira entrega). */
  subWorked?: boolean;
}

export class OpenCodeSource implements AgentSource, OpenCodeLive {
  readonly provider = 'opencode' as const;
  private accs: OpenCodeAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private trackers = new Map<string, SessionTracker>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly presenceMs: number;
  private readonly workingQuietMs: number;
  private readonly toolMaxMs: number;
  private readonly sweepMs: number;
  private readonly seenMax: number;
  private stopped = false;
  /** Leitor do banco (uma vez por processo); null = sem banco agora, tenta de novo depois de READER_RETRY_MS. */
  private readerInstance: OpenCodeTranscriptReader | null | undefined;
  private readerRetryAt = 0;
  /** Totais por sessão, com validade curta (a consulta ao banco não é de graça). */
  private readonly totalsCache = new Map<string, { at: number; value: OpenCodeTotals | undefined }>();

  constructor(private readonly opts: OpenCodeSourceOptions) {
    this.now = opts.now ?? Date.now;
    const env = opts.env ?? process.env;
    this.presenceMs = opts.presenceMs ?? envMs(env, 'HABBLAUD_OPENCODE_PRESENCE_MS', OPENCODE_PRESENCE_MS);
    this.workingQuietMs = opts.workingQuietMs ?? envMs(env, 'HABBLAUD_OPENCODE_QUIET_MS', OPENCODE_WORKING_QUIET_MS);
    this.toolMaxMs = opts.toolMaxMs ?? envMs(env, 'HABBLAUD_OPENCODE_TOOL_MAX_MS', OPENCODE_TOOL_MAX_MS);
    this.sweepMs = opts.sweepMs ?? OPENCODE_SWEEP_MS;
    this.seenMax = opts.seenMax ?? SEEN_MAX;
    // Letras e cores já usadas por QUALQUER conta (Claude Code e Codex): as do OpenCode não podem colidir.
    const taken = opts.accounts.allEntries();
    this.detected = detectOpenCodeAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: taken.map((e) => e.detected.short), colors: taken.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registra (de novo) as contas no AccountsService, sempre na mesma ordem: os ids não mudam. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'opencode',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    this.accs = entries.map((e) => ({ id: e.id, dir: e.dir, configDir: e.detected.configDir }));
  }

  /** Contas do OpenCode (ids finais, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.poll(), this.sweepMs);
    this.timer.unref?.();
  }

  /** Uma varredura de presença agora (chamada pelo timer; os testes chamam direto). */
  poll(): void {
    this.safeSweep();
  }

  /** Não há nada a reconstruir: os agentes do OpenCode só aparecem com eventos reais. Boot curto, num `finally`. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      // nada persistido para reler (o plugin é a fonte)
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.readerInstance?.close();
    this.readerInstance = undefined;
    this.totalsCache.clear();
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.trackers.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      return { label: acc.id, provider: 'opencode', path: acc.configDir, sessions, ok: true };
    });
  }

  /** O OpenCode não grava um transcript em arquivo como o Claude Code/Codex: a conversa sai do próprio banco. */
  transcriptPathOf(): string | undefined {
    return undefined;
  }

  /**
   * Conversa ao vivo da sessão, lida do banco do OpenCode (sem arquivo em disco). Cada conexão do terminal pede a sua.
   * Devolve undefined se o agente não é desta fonte (ou já saiu do escritório).
   */
  liveConversation(agentId: string): LiveConversation | undefined {
    const t = this.trackers.get(agentId);
    if (!t || !this.opts.office.has(agentId)) return undefined;
    const reader = this.reader();
    if (!reader) return undefined;
    return new OpenCodeLiveConversation(reader, t.sessionId, t.directory);
  }

  // ---------------------------------------------------------------- eventos (OpenCodeLive)

  applyEvent(account: string | undefined, event: Rec): boolean {
    try {
      return this.event(account, event);
    } catch (err) {
      log.warnOnce(`opencode-event:${errMsg(err)}`, tr('OpenCode: evento ignorado ({0}).', [errMsg(err)]));
      return false;
    }
  }

  private event(account: string | undefined, e: Rec): boolean {
    const type = str(e.type);
    if (!type || !EVENT_TYPES.has(type)) return false;
    const sessionId = str(e.sessionID);
    if (!sessionId) return false;
    // Sessão de shell do terminal (`sh_...`): não é agente nem gente trabalhando, então não entra no escritório.
    if (sessionId.startsWith(SHELL_SESSION_PREFIX)) return false;
    const id = str(e.id);
    if (id) {
      if (this.seen.has(id)) return true; // já aplicado: várias instâncias do plugin repetem o mesmo id
      this.remember(id);
    }
    const now = this.now();
    const at = this.eventAt(e, now);
    const acc = this.accountFor(account, sessionId);
    if (!acc) return false;
    const t = this.touch(acc, sessionId, now, at, str(e.directory));
    this.apply(t, type, e, at, now);
    if (t.status !== 'offline') this.enter(t);
    return true;
  }

  private eventAt(e: Rec, now: number): number {
    const raw = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : now;
    return raw > 0 && raw <= now + 2_000 ? raw : now; // fora disso (relógio estranho): o do servidor
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > this.seenMax) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }

  /** Tracker da sessão (criado se preciso), renovando a presença. */
  private touch(acc: OpenCodeAccount, sessionId: string, now: number, at: number, directory: string | undefined): SessionTracker {
    const key = `${acc.id}:${sessionId}`;
    let t = this.trackers.get(key);
    if (!t) {
      t = {
        key,
        acc,
        sessionId,
        kind: 'main',
        status: 'idle',
        statusAt: at,
        inOffice: false,
        startedAt: at,
        lastEventAt: now,
        subDone: false,
      };
      this.trackers.set(key, t);
    }
    t.lastEventAt = now;
    if (directory) t.directory = directory;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;
    return t;
  }

  /** Aplica um evento ao tracker (status, metadados, atividades). */
  private apply(t: SessionTracker, type: string, e: Rec, at: number, now: number): void {
    const office = this.opts.office;
    switch (type) {
      case 'session.create': {
        t.title ??= str(e.title);
        t.agent ??= str(e.agent);
        t.model ??= str(e.model);
        const parent = str(e.parentID);
        if (parent && parent !== t.sessionId && !t.inOffice) {
          t.kind = 'sub';
          t.parentSessionId = parent;
        }
        this.syncMeta(t);
        break;
      }
      case 'session.rename': {
        const title = str(e.title);
        if (title && title !== t.title) {
          t.title = title;
          this.syncMeta(t);
        }
        break;
      }
      case 'session.model':
        this.meta(t, str(e.model), undefined);
        break;
      case 'session.agent':
        t.agent = str(e.agent) ?? t.agent;
        break;
      case 'session.move': {
        const dir = str(e.directory);
        if (dir) t.directory = dir;
        break;
      }
      case 'session.turn.start':
        this.setStatus(t, 'working', undefined, at);
        break;
      case 'session.step':
        this.meta(t, str(e.model), str(e.agent));
        this.setStatus(t, 'working', undefined, at);
        break;
      case 'session.turn.end': {
        const result = str(e.result);
        if (result === 'error') this.errorActivity(t, at, now, SPECIAL.error());
        else if (result === 'interrupted') this.errorActivity(t, at, now, SPECIAL.interrupted());
        t.toolRun = undefined;
        this.setStatus(t, 'idle', undefined, at);
        // Fim de turno é o momento natural de reler o banco: o título automático e as tarefas costumam chegar aqui.
        this.syncMeta(t);
        break;
      }
      case 'session.usage':
        // O OpenCode gravou uso novo (um passo, o título automático, uma compactação): os números podem estar
        // velhos e o que acabou de ser gravado pode incluir o título. Relê agora, respeitando o intervalo mínimo.
        this.refreshTotals(t.sessionId);
        this.syncMeta(t);
        break;
      case 'session.retry':
        this.retryActivity(t, at);
        break;
      case 'session.compact':
        if (t.inOffice) {
          const id = str(e.id) ?? now.toString(36);
          this.opts.office.addActivity(t.key, { id: `${t.key}#compact:${id}`, at, ...SPECIAL.compact() }, true);
        }
        break;
      case 'session.status':
        this.setStatus(t, str(e.status) === 'idle' ? 'idle' : 'working', undefined, at);
        break;
      case 'session.permission':
        if (e.asking === true) this.setStatus(t, 'waiting', tr('aprovar uma permissão'), at);
        else this.setStatus(t, 'working', undefined, at);
        break;
      case 'session.error':
        this.errorActivity(t, at, now, SPECIAL.error());
        break;
      case 'tool.start': {
        this.setStatus(t, 'working', undefined, at);
        t.toolRun = { at };
        const desc = describeOpenCodeTool(str(e.tool));
        if (t.inOffice) {
          const uid = str(e.toolId) ?? `tool:${now.toString(36)}`;
          office.addActivity(t.key, { id: `${t.key}#${uid}`, at, ...desc }, true);
        }
        break;
      }
      case 'tool.end':
        t.toolRun = undefined;
        break;
      case 'session.delete':
        this.close(t);
        break;
      default:
        // session.ping: só renova a presença (o touch já fez).
        break;
    }
  }

  /** Modelo/agente de um passo: só grava e reflete no escritório quando muda. */
  private meta(t: SessionTracker, model: string | undefined, agent: string | undefined): void {
    let changed = false;
    if (model && model !== t.model) {
      t.model = model;
      changed = true;
    }
    if (agent && agent !== t.agent) {
      t.agent = agent;
      changed = true;
    }
    if (changed) this.syncMeta(t);
  }

  /**
   * Retentativa da API: o escritório mostra "tentando de novo" (mesma ideia do `api_error` do Claude Code), no
   * máximo uma vez por OPENCODE_RETRY_QUIET_MS para uma sequência de tentativas não virar uma pilha de avisos.
   */
  private retryActivity(t: SessionTracker, at: number): void {
    if (at - (t.lastRetryAt ?? 0) < OPENCODE_RETRY_QUIET_MS) return;
    t.lastRetryAt = at;
    if (!t.inOffice) return;
    this.opts.office.addActivity(t.key, { id: `${t.key}#retry:${at.toString(36)}`, at, ...SPECIAL.apiRetry() }, true);
  }

  private errorActivity(t: SessionTracker, at: number, now: number, desc: ReturnType<typeof SPECIAL.error>): void {
    if (!t.inOffice) return;
    const kind = desc.kind === 'wait' ? 'int' : 'err';
    this.opts.office.addActivity(t.key, { id: `${t.key}#${kind}:${now.toString(36)}`, at, ...desc }, true);
  }

  /** Muda o status por uma borda de evento: informação mais velha que a última decisão não vale. */
  private setStatus(t: SessionTracker, status: AgentStatus, waitingFor: string | undefined, at: number): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    if (t.kind === 'sub' && status === 'working') t.subWorked = true;
    const changed = t.status !== status;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (changed && t.inOffice) this.statusToOffice(t);
  }

  /** Leva o status do tracker ao escritório (o subagente entrega ao ficar ocioso e volta ao trabalhar). */
  private statusToOffice(t: SessionTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, t.status, t.waitingFor);
      return;
    }
    // Entrega só depois de ter trabalhado: um sub que aparece já ocioso não vira 'done' sem ter feito nada.
    if (t.status === 'idle' && t.subWorked) {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, t.status, t.waitingFor);
  }

  /** Título, modelo, tarefas e os números reais do agente (tokens, custo e ferramentas) no escritório. */
  private syncMeta(t: SessionTracker): void {
    if (!t.inOffice) return;
    const totals = this.totalsFor(t.sessionId);
    const summary: TranscriptSummary = {
      // As tarefas saem do banco (a última lista da ferramenta todo/todowrite): o plugin manda o nome da
      // ferramenta, nunca os argumentos, então o escritório não teria como ver a lista de outro jeito.
      tasks: totals?.tasks ?? [],
      stats: {
        toolCalls: totals?.toolCalls ?? 0,
        tokensIn: totals?.tokensIn ?? 0,
        tokensOut: totals?.tokensOut ?? 0,
        subagents: 0,
        costUSD: totals?.costUSD,
      },
    };
    // O título do evento manda (renome na hora); sem ele, vale o do banco — é a única forma de ver o título
    // AUTOMÁTICO, que o OpenCode grava depois do primeiro pedido sem emitir um evento de renome.
    const title = t.title ?? totals?.title;
    if (title) summary.title = title;
    if (t.model) summary.model = t.model;
    this.opts.office.applyTranscript(t.key, summary);
  }

  /** Leitor do banco do OpenCode (uma vez por processo). Sem banco ou Node antigo: undefined, e tenta de novo depois. */
  private reader(): OpenCodeTranscriptReader | undefined {
    if (this.readerInstance) return this.readerInstance;
    if (this.readerInstance === null && this.now() < this.readerRetryAt) return undefined;
    try {
      const created = this.opts.transcriptReader ? this.opts.transcriptReader() : openOpenCodeTranscriptReader(openCodeDbPath(this.opts.env ?? process.env, this.opts.home));
      this.readerInstance = created ?? null;
    } catch (err) {
      log.warnOnce(`opencode-db:${errMsg(err)}`, tr('OpenCode: falha ao abrir o banco da conversa ({0}).', [errMsg(err)]));
      this.readerInstance = null;
    }
    if (!this.readerInstance) this.readerRetryAt = this.now() + READER_RETRY_MS;
    return this.readerInstance ?? undefined;
  }

  /** Totais da sessão (tokens, custo, ferramentas), com cache curto: cada leitura é uma consulta ao banco. */
  private totalsFor(sessionId: string): OpenCodeTotals | undefined {
    const now = this.now();
    const hit = this.totalsCache.get(sessionId);
    if (hit && now - hit.at < OPENCODE_TOTALS_MS) return hit.value;
    const reader = this.reader();
    let value: OpenCodeTotals | undefined;
    if (reader) {
      try {
        value = reader.totals(sessionId);
      } catch (err) {
        log.warnOnce(`opencode-totals:${errMsg(err)}`, tr('OpenCode: falha ao ler os totais da sessão ({0}).', [errMsg(err)]));
      }
    }
    this.totalsCache.set(sessionId, { at: now, value });
    return value;
  }

  /**
   * Totais velhos demais para o uso que acabou de ser gravado: descarta o cache para a próxima leitura trazer os
   * números (e o título) novos. Respeita OPENCODE_USAGE_MS: um passo atrás do outro não relê o banco a cada evento.
   */
  private refreshTotals(sessionId: string): void {
    const hit = this.totalsCache.get(sessionId);
    if (hit && this.now() - hit.at < OPENCODE_USAGE_MS) return;
    this.totalsCache.delete(sessionId);
  }

  /** Entra no escritório quando já há pasta do projeto (a sala); sem pasta, espera um evento que a traga. */
  private enter(t: SessionTracker): void {
    if (t.inOffice) return;
    const office = this.opts.office;
    const cwd = t.directory;
    if (!cwd) return;
    if (t.kind === 'sub') {
      const parentKey = this.parentKey(t);
      if (!parentKey || !office.has(parentKey)) return; // o pai ainda não está no escritório
      office.addSub({
        id: t.key,
        parentId: parentKey,
        sessionId: t.sessionId,
        role: this.roleOf(t),
        title: t.title,
        background: false,
        startedAt: t.startedAt,
      });
      t.inOffice = office.has(t.key);
      if (t.inOffice) this.statusToOffice(t);
      return;
    }
    office.addMain({
      id: t.key,
      provider: 'opencode',
      account: t.acc.id,
      sessionId: t.sessionId,
      cwd,
      role: MAIN_ROLE,
      startedAt: t.startedAt,
      status: t.status,
      waitingFor: t.waitingFor,
    });
    t.inOffice = office.has(t.key);
    if (t.inOffice) this.syncMeta(t);
  }

  private parentKey(t: SessionTracker): string | undefined {
    return t.parentSessionId ? `${t.acc.id}:${t.parentSessionId}` : undefined;
  }

  private roleOf(t: SessionTracker): string {
    if (t.kind !== 'sub') return MAIN_ROLE;
    const a = t.agent?.trim();
    return a ? `${a[0].toUpperCase()}${a.slice(1)}` : SUB_ROLE;
  }

  private accountFor(account: string | undefined, sessionId: string): OpenCodeAccount | undefined {
    if (account) {
      const byId = this.accs.find((a) => a.id === account);
      if (byId) return byId;
      const byName = this.accs.find((a) => a.dir === account || a.configDir === account || a.dir.endsWith(`/${account}`));
      if (byName) return byName;
    }
    const known = this.accs.filter((a) => this.trackers.has(`${a.id}:${sessionId}`));
    if (known.length === 1) return known[0];
    // O OpenCode é global: com uma conta só (o normal), é ela; o plugin nem manda conta.
    return this.accs.length === 1 ? this.accs[0] : known[0] ?? this.accs[0];
  }

  // ---------------------------------------------------------------- varredura (presença)

  private safeSweep(): void {
    if (this.stopped) return;
    try {
      this.sweep();
    } catch (err) {
      log.warnOnce(`opencode-sweep:${errMsg(err)}`, tr('OpenCode: falha ao revisar as sessões ({0}).', [errMsg(err)]));
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const t of [...this.trackers.values()]) {
      if (t.toolRun) {
        if (now - t.toolRun.at > this.toolMaxMs) t.toolRun = undefined; // ferramenta presumidamente morta
        else continue; // uma rodada longa mantém o agente presente
      }
      const silent = now - t.lastEventAt;
      if (silent > this.presenceMs) {
        this.close(t);
        continue;
      }
      if (t.status === 'working' && silent > this.workingQuietMs) this.setStatus(t, 'idle', undefined, now);
    }
  }

  private close(t: SessionTracker): void {
    if (t.inOffice) {
      const office = this.opts.office;
      if (t.kind === 'sub') {
        if (!t.subDone) office.completeSub(t.key);
        t.subDone = true;
      } else office.closeMain(t.key);
    }
    t.inOffice = false;
    t.status = 'offline';
    this.trackers.delete(t.key);
  }
}

