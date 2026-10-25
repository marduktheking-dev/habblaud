// Novo agente pelo escritório, no OpenCode: uma sessão nova do CLI (`opencode run --title ...`), com o pedido pela
// entrada padrão. O processo começa na hora, aparece no escritório pela fonte do OpenCode (banco + plugin) e recebe
// mensagens pelo mesmo caminho das sessões que já existiam (`opencode run --session`).
//
// O OpenCode não tem um "app" com deep link como o Claude Code, então não há tela para preencher quando o CLI falha:
// o erro volta para a pessoa. Sem pedido, também não inventamos um: uma sessão do OpenCode começa com uma mensagem.
//
// O título é o nome da pasta (`Habblaud: projetos`), não o pedido: o texto do pedido vai só pela entrada padrão, para
// não virar opção do CLI e não aparecer no `ps`.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg } from '../log';
import type { CliResult, CliRunner, SpawnRequest } from './spawn';

/** O CLI pode demorar para subir (serviço compartilhado frio); depois disto, a sessão vale como aberta. */
export const OPENCODE_SPAWN_TIMEOUT_MS = 8_000;

/** Argumentos do `opencode run`: sem `--session`, ele cria uma sessão nova. */
export function openCodeArgs(req: SpawnRequest): string[] {
  const folder = basename(req.folder.replace(/[\\/]+$/, ''));
  return ['run', '--title', `Habblaud: ${folder || 'projeto'}`];
}

/**
 * Roda `opencode run` numa sessão nova. Sucesso = o processo subiu (o turno pode continuar depois); a fonte do
 * OpenCode encontra a sessão sozinha. Sem pedido, recusa: não há o que abrir.
 */
export function createOpenCodeCliRunner(bin: string, timeoutMs = OPENCODE_SPAWN_TIMEOUT_MS): CliRunner {
  return (req) => {
    if (!req.prompt.trim()) {
      return Promise.resolve({ ok: false, error: tr('o OpenCode precisa de um pedido para começar uma sessão nova') });
    }
    return new Promise<CliResult>((resolve) => {
      let done = false;
      const finish = (r: CliResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, openCodeArgs(req), {
          cwd: req.folder,
          // O `opencode` escolhe o projeto pelo `PWD` do ambiente, não pelo cwd do processo: sem isto, a sessão
          // nasceria na pasta de quem roda o Habblaud (o serviço), não na pasta escolhida.
          env: { ...process.env, PWD: req.folder },
          stdio: ['pipe', 'ignore', 'ignore'],
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        return finish({ ok: false, error: errMsg(err) });
      }
      // O CLI pode sair antes de ler (serviço frio, sessão recusada): a escrita quebra e emite EPIPE; sem isto, o
      // erro viraria uma exceção solta no servidor.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(req.prompt);
      const timer = setTimeout(() => {
        // Já subiu e ainda não voltou: o turno segue no serviço do OpenCode; não esperamos a resposta.
        try {
          child.unref();
        } catch {
          /* nada */
        }
        finish({ ok: true, id: randomUUID() });
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (err) => finish({ ok: false, error: errMsg(err) }));
      child.once('spawn', () => {
        try {
          child.unref();
        } catch {
          /* nada */
        }
        finish({ ok: true, id: randomUUID() });
      });
    });
  };
}
