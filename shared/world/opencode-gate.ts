// Gate do OpenCode no Habblaud World: decide se um agente do OpenCode pode entrar no pacote do prédio, e devolve o
// conjunto de `provider` que está valendo agora. Puro (sem Node nem rede): o estado chega pronto de quem observa o
// contrato publicado (server/world/schema-probe.ts) e de quem fala com o servidor (server/world/uplink.ts).
//
// Por que existe: o protocolo do mundo validava `provider` com ["claude", "codex"]. Mandar "opencode" faz o servidor
// recusar o pacote INTEIRO (ack error "schema") e repetir a remessa só gera erro e pode marcar anomalia na conta; virar
// "claude" seria mentir sobre a ferramenta que está rodando (Termos, seção "Dados verdadeiros" — server/world/uplink.ts
// AVISO). Então o pacote é montado só com o que o contrato remoto aceita, e o OpenCode entra sozinho no dia em que o
// contrato publicado passar a aceitá-lo.
//
// Quatro barreiras, todas precisam estar abertas (fail-safe: qualquer uma fechada = não manda OpenCode):
//   1. flag ligada (HABBLAUD_WORLD_OPENCODE; off = humana dizendo não);
//   2. sonda do schema publicado fresca (< OPENCODE_PROBE_MAX_AGE_MS) e observada pelo menos duas vezes;
//   3. o enum remoto contém "opencode";
//   4. o servidor não recusou um pacote recentemente (ack "schema"/"implausible" nos últimos OPENCODE_ACK_COOLDOWN_MS).
import type { UplinkAckError, WorldProvider } from './protocol';

/** O que sai por padrão: o contrato publicado hoje (shared/world/schema.json, o mesmo que o servidor copia). */
export const WORLD_PUBLISHED_PROVIDERS: readonly WorldProvider[] = ['claude', 'codex'];

/** O que o Habblaud sabe representar (Provider em shared/types.ts), na ordem do protocolo. */
export const HABBLAUD_PROVIDERS: readonly WorldProvider[] = ['claude', 'codex', 'opencode'];

/** Por que o gate está aberto ou fechado (vai para /api/world/status e para o log). */
export type OpenCodeGateReason = 'open' | 'flag_off' | 'unknown_remote' | 'remote_denied' | 'ack_cut';

/** Sonda do schema publicado (server/world/schema-probe.ts), congelada aqui como dado. */
export interface OpenCodeProbe {
  /** `provider.enum` lido do schema remoto; ausente = a leitura não deu para interpretar. */
  providers?: readonly string[];
  /** Última leitura bem-sucedida (ms); ausente = nunca leu. */
  checkedAt?: number;
  /** Leituras bem-sucedidas do contrato (qualquer conteúdo): só diagnóstico. */
  observations?: number;
  /** Leituras SEGUIDAS que trouxeram "opencode": é esta que o gate exige duas antes de abrir. */
  opencodeObservations?: number;
  /** Último erro da leitura (só para diagnóstico; nunca abre o gate). */
  error?: string;
}

export interface OpenCodeGateState {
  /** HABBLAUD_WORLD_OPENCODE ligada. */
  flag: boolean;
  probe?: OpenCodeProbe;
  /** O servidor recusou o último pacote por formato/plausibilidade (ack do uplink). */
  cut?: { at: number; error: UplinkAckError };
  now: number;
}

/**
 * O que o quem observa a rede entrega (flag + leitura do contrato): `now` e `cut` são de quem fala com o servidor
 * (server/world/uplink.ts) e completam o estado na hora de decidir.
 */
export type OpenCodeGateInput = Pick<OpenCodeGateState, 'flag'> & Partial<Pick<OpenCodeGateState, 'probe' | 'cut'>>;

export interface OpenCodeGateResult {
  /** Só com `true` o pacote pode conter provider além dos publicados. */
  allowed: boolean;
  reason: OpenCodeGateReason;
  /** Providers que a projeção pode emitir AGORA (sempre ⊆ enum remoto observado, senão o publicado). */
  providers: readonly WorldProvider[];
  /** Última leitura do contrato remoto (ms), para a interface mostrar "checado às …". */
  checkedAt?: number;
}

/** Uma sonda mais velha que isso não vale mais para decidir (a cada 6 h; folga de 1 h). */
export const OPENCODE_PROBE_MAX_AGE_MS = 7 * 3_600_000;
/** Leituras mínimas do contrato remoto antes de abrir (uma resposta isolada não decide). */
export const OPENCODE_MIN_OBSERVATIONS = 2;
/** Depois de uma recusa do servidor, quanto tempo fechado (sem reenviar o valor recusado). */
export const OPENCODE_ACK_COOLDOWN_MS = 6 * 3_600_000;

/** O ack recusou por formato ou por plausibilidade: esses dois fecham o gate (os demais erros não têm a ver com ele). */
export function ackCutsGate(error: UplinkAckError | undefined): boolean {
  return error === 'schema' || error === 'implausible';
}

/**
 * Uma recusa por formato/plausibilidade vira corte, desde que o ack seja o do ÚLTIMO pacote (o uplink guarda o ack mais
 * recente: um pacote aceito depois limpa o corte sozinho).
 */
export function cutFromAck(ack: { ok: boolean; error?: UplinkAckError; at?: number } | undefined): { at: number; error: UplinkAckError } | undefined {
  if (!ack || ack.ok || !ackCutsGate(ack.error)) return undefined;
  return { at: ack.at ?? 0, error: ack.error! };
}

/** Decide. Qualquer barreira fechada devolve `allowed: false` e o conjunto publicado (nunca mais do que o contrato). */
export function openCodeGate(state: OpenCodeGateState): OpenCodeGateResult {
  const checkedAt = state.probe?.checkedAt;
  const closed = (reason: OpenCodeGateReason): OpenCodeGateResult => ({ allowed: false, reason, providers: WORLD_PUBLISHED_PROVIDERS, checkedAt });

  if (!state.flag) return closed('flag_off');
  const probe = state.probe;
  if (!probe?.checkedAt || state.now - probe.checkedAt > OPENCODE_PROBE_MAX_AGE_MS) return closed('unknown_remote');
  const remote = probe.providers ?? [];
  // Contrato lido e sem "opencode": é recusa do remoto (não precisa de duas confirmações para dizer "ainda não").
  if (!remote.includes('opencode')) return closed('remote_denied');
  // Com "opencode": uma leitura isolada não decide (resposta transitória não arma o envio).
  if ((probe.opencodeObservations ?? 0) < OPENCODE_MIN_OBSERVATIONS) return closed('unknown_remote');
  const cut = state.cut;
  if (cut && state.now - cut.at < OPENCODE_ACK_COOLDOWN_MS) return closed('ack_cut');

  const providers = HABBLAUD_PROVIDERS.filter((p) => remote.includes(p));
  if (!providers.includes('opencode')) return closed('remote_denied');
  return { allowed: true, reason: 'open', providers, checkedAt };
}

/** O que vai em `WorldBuildingStatus.opencode` (a interface mostra por que o prédio está sem andares do OpenCode). */
export interface OpenCodeGateView extends Pick<OpenCodeGateResult, 'allowed' | 'reason'> {
  flag: boolean;
  providers: readonly WorldProvider[];
  checkedAt?: number;
  /** Sonda falhando: o motivo do erro (a interface só mostra que está sem leitura). */
  probeError?: string;
  /** A última recusa do servidor que está mantendo o gate fechado. */
  cut?: { at: number; error: UplinkAckError };
}

/** Visão do gate para /api/world/status. */
export function openCodeGateView(result: OpenCodeGateResult, state: OpenCodeGateState): OpenCodeGateView {
  const view: OpenCodeGateView = { allowed: result.allowed, reason: result.reason, flag: state.flag, providers: result.providers };
  if (result.checkedAt !== undefined) view.checkedAt = result.checkedAt;
  if (state.probe?.error) view.probeError = state.probe.error;
  if (state.cut) view.cut = state.cut;
  return view;
}
