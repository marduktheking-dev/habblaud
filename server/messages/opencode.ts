// Mensagens para agentes do OpenCode: o servidor entrega rodando o CLI do OpenCode numa sessão existente
// (`opencode run --session <id>`, com o texto pela entrada padrão), como o Codex faz com o `codex queue`. O texto
// entra na sessão como se a pessoa o tivesse digitado; o modelo da sessão não é tocado (nunca passamos --model) e
// nenhuma permissão é aprovada sozinha (nunca passamos --auto): o pedido de permissão continua parando na tela do
// OpenCode.
//
// Privacidade: este arquivo NÃO lê o banco do OpenCode (opencode.db) nem credenciais — só procura o binário no PATH
// e roda o CLI. O que sai daqui é o texto que a própria pessoa escreveu no Habblaud e o id da sessão.
//
// Sem o binário (ou com um comando apontado por HABBLAUD_OPENCODE_BIN), o agente do OpenCode simplesmente não
// recebe mensagens: o snapshot não marca canMessage e a caixa mostra a dica.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { MESSAGE_MAX } from '../../shared/messages';
import { errMsg } from '../log';
import { tr } from '../../shared/i18n';

/** Nomes procurados no PATH, nesta ordem (o pacote do Termux instala `opencode-termux`). */
export const OPENCODE_BINS = ['opencode-termux', 'opencode'];
/** Variável para apontar o CLI (caminho absoluto ou comando no PATH); aceita o mesmo nome em qualquer sistema. */
export const OPENCODE_BIN_ENV = 'HABBLAUD_OPENCODE_BIN';
/** O CLI pode demorar para subir (serviço compartilhado frio); depois disto a entrega vale como "na fila". */
export const SPAWN_TIMEOUT_MS = 8_000;

export interface DeliverResult {
  ok: boolean;
  /** Mensagem de erro quando `ok` é false (já traduzida). */
  error?: string;
  /** true = o processo subiu, mas demorou; a mensagem entra na fila do serviço. */
  queued?: boolean;
}

function isExecutable(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    // Sem permissão de execução não adianta tentar.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Caminho do CLI do OpenCode: HABBLAUD_OPENCODE_BIN (se definida), senão o primeiro nome conhecido no PATH.
 * `undefined` = não há como entregar.
 */
export function findBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const custom = env[OPENCODE_BIN_ENV]?.trim();
  if (custom) {
    if (isAbsolute(custom)) return isExecutable(custom) ? custom : undefined;
    return findOnPath(custom, env) ?? undefined;
  }
  for (const name of OPENCODE_BINS) {
    const found = findOnPath(name, env);
    if (found) return found;
  }
  return undefined;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? '';
  if (!path) return undefined;
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p) && isExecutable(p)) return p;
    }
  }
  return undefined;
}

/** Dá para entregar agora? (só o binário; a sessão é conferida pelo próprio CLI ao subir). */
export function canDeliver(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason?: string } {
  const bin = findBinary(env);
  if (!bin) return { ok: false, reason: tr('binário do OpenCode não encontrado: instale o OpenCode (opencode-termux) ou aponte HABBLAUD_OPENCODE_BIN') };
  return { ok: true };
}

/** Id de sessão que aceitamos passar ao CLI (os do OpenCode são `ses_…`): nada de espaços, hífens ou opções. */
const SESSION_ID_RE = /^[A-Za-z0-9._:]{1,200}$/;

/**
 * Entrega `text` na sessão `sessionId` rodando o CLI. Sucesso = o processo subiu (o serviço do OpenCode recebe o
 * prompt mesmo que o turno demore). Não espera a resposta do modelo.
 *
 * O texto vai pela **entrada padrão**, não na linha de comando: um texto começando com `-` seria lido como opção do
 * CLI (até `--auto`, que aprovaria permissões sozinho). Pela entrada padrão o texto chega inteiro, sem aspas e sem
 * virar flag; o `opencode run` lê a entrada até o fim e só então manda a mensagem.
 */
export function deliver(sessionId: string, text: string, opts: { spawnTimeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<DeliverResult> {
  const bin = findBinary(opts.env);
  if (!bin) {
    return Promise.resolve({ ok: false, error: tr('binário do OpenCode não encontrado: instale o OpenCode (opencode-termux) ou aponte HABBLAUD_OPENCODE_BIN') });
  }
  const body = text.replace(/\s+$/, '');
  if (!body.trim()) return Promise.resolve({ ok: false, error: tr('a mensagem está vazia') });
  if (body.length > MESSAGE_MAX) return Promise.resolve({ ok: false, error: tr('a mensagem passou do limite de {0} caracteres', [MESSAGE_MAX]) });
  const session = sessionId.trim();
  if (!session) return Promise.resolve({ ok: false, error: tr('o agente não tem sessão para receber a mensagem') });
  if (!SESSION_ID_RE.test(session)) return Promise.resolve({ ok: false, error: tr('a sessão do OpenCode tem um id inesperado: mensagem não enviada') });

  const timeout = opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS;
  const args = ['run', '--session', session];
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DeliverResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32', env: opts.env ?? process.env });
    } catch (err) {
      return finish({ ok: false, error: errMsg(err) });
    }
    // O CLI pode sair antes de ler (sessão inexistente): a escrita quebra e emite EPIPE; sem isto, o erro viraria
    // uma exceção solta no servidor.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(body);
    const timer = setTimeout(() => {
      // Já subiu e ainda não voltou: a mensagem vai na fila do serviço; não esperamos o turno terminar.
      try {
        child.unref();
      } catch {
        /* nada */
      }
      finish({ ok: true, queued: true });
    }, timeout);
    timer.unref?.();
    child.once('error', (err) => finish({ ok: false, error: errMsg(err) }));
    child.once('spawn', () => {
      try {
        child.unref();
      } catch {
        /* nada */
      }
      finish({ ok: true });
    });
  });
}
