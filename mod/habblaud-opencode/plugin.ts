// Habblaud — eventos do OpenCode (plugin local do serviço compartilhado do OpenCode).
//
// Este arquivo é a CÓPIA de origem: o instalador (`npm run opencode:install`) copia-o para
// `<pasta do OpenCode>/plugins/habblaud-events.ts`. Para mudar o comportamento, edite aqui e rode o
// instalador de novo (ele faz backup da cópia instalada antes de regravar).
//
// Manda ao Habblaud (POST /api/opencode/events) só o que o escritório precisa para saber QUEM está
// trabalhando: criação/renome/movimentação de sessão, início/fim de turno, início/fim de ferramenta, o
// estado de execução, se há um pedido de permissão em aberto (só o fato, nunca a ação pedida), a
// compactação da memória e uma retentativa da API (as sessões de shell do terminal ficam de fora: não são
// gente trabalhando). NUNCA o texto do prompt, a resposta, os argumentos das
// ferramentas (comandos, caminhos, diffs), tokens ou credenciais — só ids, a pasta do projeto, o nome da
// ferramenta, o agente e o modelo. O modelo escolhido pela pessoa jamais é alterado. Quando o OpenCode
// grava uso novo (tokens/custo de um passo, de um título ou de uma compactação), o plugin avisa só que
// houve uso: os NÚMEROS continuam vindo do banco dele, nunca daqui.
//
// Vive no processo `opencode serve --service`, que é compartilhado e sobrevive às telas, então NÃO manda
// sinal de vida incondicional: a presença no Habblaud vem dos eventos reais + uma janela curta lá do lado
// do servidor. Com o Habblaud fora do ar nada quebra (tudo é "fire-and-forget" com timeout curto).
//
// Para onde mandar: `~/.habblaud/opencode-plugin.json` ({ "url": "http://127.0.0.1:4747" }, gravado pelo
// instalador) — assim trocar a porta não pede reinstalar o plugin. Sem esse arquivo, HABBLAUD_URL; sem
// nada, o padrão.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:4747';
/** Tempo máximo que uma entrega pode demorar; depois disso o pedido é abortado e descartado. */
const SEND_TIMEOUT_MS = 1_500;
/** Um único "sinal de vida" por sessão a cada N ms: mantém a presença viva num turno longo e calado. */
const PING_MS = 10_000;
/** Quantos ids de evento lembrar para não repetir entregas (dedupe local; o servidor também deduplica). */
const SEEN_MAX = 2_000;
/**
 * Prefixo das sessões de SHELL do OpenCode (`sh_...`): cada comando do terminal vira uma sessão dessas, que não é
 * uma pessoa trabalhando. Sem esta trava o escritório enchia de bonecos fantasma, um por comando.
 */
const SHELL_PREFIX = 'sh_';
/** Arquivo de configuração, em ~/.habblaud (o instalador grava). */
export const CONFIG_FILE = 'opencode-plugin.json';

type Rec = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Modelo como string "provedor/modelo" (ex.: "opencode/big-pickle"); nunca escolhe nem troca nada. */
function modelRef(v: unknown): string | undefined {
  const m = rec(v);
  const id = str(m?.id);
  if (!id) return undefined;
  const provider = str(m?.providerID);
  return provider ? `${provider}/${id}` : id;
}

/** Estado de `session.status` (idle | retry | busy): qualquer coisa que não seja idle é "trabalhando". */
function statusOf(v: unknown): 'working' | 'idle' {
  return str(rec(v)?.type) === 'idle' ? 'idle' : 'working';
}

/** URL do Habblaud gravada pelo instalador (undefined = não existe, ilegível ou sem url). */
function configUrl(): string | undefined {
  try {
    const home = process.env?.HABBLAUD_HOME || homedir();
    const j = rec(JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8')));
    return str(j?.url);
  } catch {
    return undefined;
  }
}

function endpoint(): string {
  const env = typeof process !== 'undefined' ? process.env?.HABBLAUD_URL : undefined;
  const raw = configUrl() ?? env;
  const base = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_URL;
  return base.replace(/\/+$/, '') + '/api/opencode/events';
}

/** Entrega um pacote; sem esperar, com timeout e sem nunca lançar (Habblaud fora do ar não atrapalha). */
async function post(payload: Rec): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    /* Habblaud fora do ar (ou lento): o OpenCode segue normalmente. */
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: 'habblaud-events',
  setup(ctx: unknown): () => void {
    const c = rec(ctx);
    const fallbackDir = str(rec(c?.location)?.directory);

    /** Pasta do projeto por sessão (para os eventos de ferramenta, que não trazem `location`). */
    const dirs = new Map<string, string>();
    /** Último título entregue por sessão: `session.updated` chega a cada mudança e o título só interessa quando muda. */
    const titleOf = new Map<string, string>();
    const lastPing = new Map<string, number>();
    const seenSet = new Set<string>();
    const seenOrder: string[] = [];

    const directoryOf = (sessionID: string | undefined): string | undefined =>
      (sessionID ? dirs.get(sessionID) : undefined) ?? fallbackDir;

    /** Já entregamos este id? (dedupe local; várias instâncias do plugin ainda podem repetir). */
    const alreadySeen = (id: string): boolean => {
      if (seenSet.has(id)) return true;
      seenSet.add(id);
      seenOrder.push(id);
      if (seenOrder.length > SEEN_MAX) {
        const old = seenOrder.shift();
        if (old) seenSet.delete(old);
      }
      return false;
    };

    const emit = (payload: Rec): void => {
      const id = str(payload.id);
      if (id && alreadySeen(id)) return;
      void post(payload);
    };

    /** Sinal de vida espaçado: um evento qualquer de sessão mantém a presença sem inundar o Habblaud. */
    const ping = (sessionID: string, at: number): void => {
      const last = lastPing.get(sessionID) ?? 0;
      if (at - last < PING_MS) return;
      lastPing.set(sessionID, at);
      emit({ id: `ping:${sessionID}:${Math.floor(at / PING_MS)}`, type: 'session.ping', sessionID, at, directory: directoryOf(sessionID) });
    };

    const onEvent = (e: unknown): void => {
      const ev = rec(e);
      const type = str(ev?.type);
      if (!type) return;
      const data = rec(ev?.data) ?? {};
      // O OpenCode manda a sessão em dois formatos: os campos direto no `data` (eventos v2, ex.: `session.renamed`)
      // e dentro de `info` (o `session.created`/`session.updated` do barramento, que traz a sessão inteira).
      const info = rec(data.info) ?? {};
      const sessionID = str(data.sessionID) ?? str(info.id) ?? str(ev?.sessionID);
      // Sessão de shell do terminal (não é gente trabalhando): nada dela interessa ao escritório.
      if (sessionID?.startsWith(SHELL_PREFIX)) return;
      const directory = str(rec(ev?.location)?.directory) ?? str(info.directory);
      const at = typeof ev?.created === 'number' ? ev.created : Date.now();
      const eventId = str(ev?.id) ?? `${type}:${sessionID ?? ''}:${at}`;
      if (sessionID && directory) dirs.set(sessionID, directory);
      const shared: Rec = { id: eventId, sessionID, directory: directory ?? directoryOf(sessionID), at };

      switch (type) {
        case 'session.created': {
          const title = str(data.title) ?? str(info.title);
          if (title && sessionID) titleOf.set(sessionID, title);
          emit({
            ...shared,
            type: 'session.create',
            title,
            agent: str(data.agent) ?? str(info.agent),
            model: modelRef(data.model) ?? modelRef(info.model),
            parentID: str(data.parentID) ?? str(info.parentID),
          });
          return;
        }
        case 'session.renamed':
        case 'session.updated': {
          // O título automático (gerado depois do primeiro pedido) não tem evento de renome próprio: ele chega
          // no `session.updated`, que dispara a cada mudança da sessão — por isso só entrega quando muda.
          const title = str(data.title) ?? str(info.title);
          if (!title || title === (sessionID ? titleOf.get(sessionID) : undefined)) return;
          if (sessionID) titleOf.set(sessionID, title);
          emit({ ...shared, type: 'session.rename', title });
          return;
        }
        case 'session.model.selected':
          emit({ ...shared, type: 'session.model', model: modelRef(data.model) });
          return;
        case 'session.agent.selected':
          emit({ ...shared, type: 'session.agent', agent: str(data.agent) });
          return;
        case 'session.moved': {
          const moved = str(rec(data.location)?.directory);
          if (sessionID && moved) dirs.set(sessionID, moved);
          emit({ ...shared, type: 'session.move', directory: moved ?? shared.directory });
          return;
        }
        case 'session.execution.started':
          emit({ ...shared, type: 'session.turn.start' });
          return;
        case 'session.step.started':
          emit({ ...shared, type: 'session.step', agent: str(data.agent), model: modelRef(data.model) });
          return;
        case 'session.execution.succeeded':
          emit({ ...shared, type: 'session.turn.end', result: 'ok' });
          return;
        case 'session.execution.failed':
          emit({ ...shared, type: 'session.turn.end', result: 'error' });
          return;
        case 'session.execution.interrupted':
          emit({ ...shared, type: 'session.turn.end', result: 'interrupted', reason: str(data.reason) });
          return;
        case 'session.idle':
          emit({ ...shared, type: 'session.status', status: 'idle' });
          return;
        case 'session.status':
          emit({ ...shared, type: 'session.status', status: statusOf(data.status) });
          return;
        case 'session.deleted':
          emit({ ...shared, type: 'session.delete' });
          return;
        case 'session.step.failed':
          emit({ ...shared, type: 'session.error' });
          return;
        // Uso novo gravado pelo OpenCode (um passo, o título automático ou uma compactação): vai só o fato. Os
        // números (tokens, custo) são lidos do banco pelo Habblaud; isto só faz ele reler na hora, sem esperar.
        case 'session.usage.recorded':
        case 'session.usage.updated':
          emit({ ...shared, type: 'session.usage' });
          return;
        // Retentativa da API (instabilidade): o escritório mostra "tentando de novo" em vez de parecer parado.
        case 'session.retry.scheduled':
          emit({ ...shared, type: 'session.retry' });
          return;
        // Compactação da memória (o contexto encheu): a mesma ideia do compact_boundary do Claude Code.
        case 'session.compaction.started':
          emit({ ...shared, type: 'session.compact' });
          return;
        // O pedido de permissão (aprovar um comando/ferramenta) PARA o turno: sem isto o escritório mostraria
        // "trabalhando" enquanto a pessoa decide. Vai só o fato (asking), nunca a ação nem os recursos pedidos.
        case 'permission.asked':
          emit({ ...shared, type: 'session.permission', asking: true });
          return;
        case 'permission.replied':
          emit({ ...shared, type: 'session.permission', asking: false });
          return;
        case 'session.tool.input.started':
          emit({ ...shared, type: 'tool.start', tool: str(data.name), toolId: str(data.id) });
          return;
        case 'session.tool.success':
          emit({ ...shared, type: 'tool.end', ok: true, toolId: str(data.id) });
          return;
        case 'session.tool.failed':
          emit({ ...shared, type: 'tool.end', ok: false, toolId: str(data.id) });
          return;
        default:
          // Evento que não muda o escritório (texto, raciocínio, progresso...): só mantém a presença.
          if (sessionID) ping(sessionID, at);
          return;
      }
    };

    try {
      const sub = (c?.event as { subscribe?: (o?: unknown) => unknown } | undefined)?.subscribe?.({ onActivity: () => {} });
      if (sub && typeof (sub as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
        void (async () => {
          try {
            for await (const e of sub as AsyncIterable<unknown>) {
              try {
                onEvent(e);
              } catch {
                /* um evento estranho não derruba a assinatura */
              }
            }
          } catch {
            /* a assinatura caiu (serviço encerrando): nada a fazer */
          }
        })();
      }
    } catch {
      /* sem event.subscribe: o plugin fica inerte, sem atrapalhar o OpenCode */
    }

    return () => {
      /* nada persistente para limpar */
    };
  },
};
