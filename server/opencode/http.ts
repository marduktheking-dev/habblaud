// Eventos ao vivo do OpenCode: o plugin local (~/.config/opencode/plugins/habblaud-events.ts) roda dentro do
// processo compartilhado do OpenCode, observa os eventos reais da sessão e manda um pacote já normalizado para
// cá. A rota repassa o pacote à fonte do OpenCode (OpenCodeLive), que atualiza o agente na hora, sem esperar
// nada. Só observa (a resposta nunca volta para a sessão) e só vale vindo do próprio computador: a trava (Host
// local e, fora do Docker, conexão pelo loopback) é conferida em http/app.ts. O guard (http/guard.ts) já exigiu
// JSON.
//
//   POST /api/opencode/events   (plugin)   {id?, type, sessionID, directory?, at?, ...}: 200 {ok}
//
// O corpo é o pacote normalizado do plugin: só ids, a pasta do projeto, o nome da ferramenta, o agente e o
// modelo — nunca o texto do prompt, a resposta ou os argumentos das ferramentas.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { OpenCodeLive } from '../sources/opencode/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Corpo de POST /api/opencode/events. Sem `type`/`sessionID` (strings): 400. */
export function parseOpenCodeEvent(raw: unknown): Rec {
  const r = rec(raw);
  const type = typeof r?.type === 'string' ? r.type.trim() : '';
  const sessionID = typeof r?.sessionID === 'string' ? r.sessionID.trim() : '';
  if (!r || !type || type.length > 80 || !sessionID || sessionID.length > 200) {
    throw new HttpError(400, 'esperado {type, sessionID, ...} (o pacote normalizado do plugin do OpenCode)');
  }
  return r;
}

/** Trata POST /api/opencode/events (método e Host já conferidos). `ok` = a fonte do OpenCode aproveitou o evento. */
export async function handleOpenCodeEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: OpenCodeLive },
): Promise<void> {
  const body = parseOpenCodeEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      // O OpenCode é uma instalação global: o plugin nem manda conta, então ela fica indefinida (a fonte deduz).
      ok = deps.live.applyEvent(undefined, body) === true;
    } catch (err) {
      log.warnOnce(`opencode-event:${errMsg(err)}`, tr('Eventos do OpenCode: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
