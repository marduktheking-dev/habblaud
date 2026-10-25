// Eventos ao vivo do OpenCode (o plugin local manda em POST /api/opencode/events, server/opencode/http.ts). A
// fonte do OpenCode (sources/opencode/source.ts) implementa isto e atualiza o agente na hora, sem esperar nada.
//
// O evento é o pacote normalizado que o plugin monta (ver shared/README ou o próprio plugin): só ids, a pasta do
// projeto, o nome da ferramenta, o agente e o modelo — nunca o texto do prompt, a resposta ou os argumentos.
export interface OpenCodeLive {
  /** Aplica um evento do OpenCode; `account` é opcional (o plugin não manda conta: o OpenCode é global). */
  applyEvent(account: string | undefined, event: Record<string, unknown>): boolean;
}
