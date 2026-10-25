# OpenCode no Habblaud World: por que o prédio fica sem andares

**Estado em 25/10/2026:** bloqueado no protocolo do World, não no Habblaud local.

O escritório local mostra as sessões do OpenCode normalmente (sala, personagem, conversa e totais). O que não sobe é o
pacote do prédio: o World só aceita `provider: "claude"` ou `"codex"` em `shared/world/schema.json`, e o servidor do
World guarda uma cópia exata desse schema. Um prédio com só agentes do OpenCode sobe com `floors: []`; o `ack` vem
`ok: true` porque o pacote é válido, mas não há andar para mostrar.

## Evidência

- `shared/world/schema.json` (e o `main` público em 25/10/2026): o enum de `provider` é `["claude", "codex"]`.
- O PR upstream #139 ("Add experimental OpenCode v2 sessions to the office") diz explicitamente: "Agentes OpenCode não
  são enviados como Claude ao Habblaud World, cujo protocolo ainda suporta apenas Claude/Codex."
- `~/.habblaud/world-last-uplink.json` depois de reiniciar o serviço: `ack.ok: true`, `uplink.floors: 0`,
  `uplink.agents: 0`. O World está conectado (conta aprovada), mas sem andares.

## O que não fazer

- **Não** mapear OpenCode para `claude` ou `codex`. O campo `provider` é a ferramenta que está rodando; trocar o valor
  seria mentir sobre os dados e quebra os termos do World (dados verdadeiros).
- **Não** mandar `provider: "opencode"` com o schema/servidor atuais. O pacote inteiro é recusado; repetir a remessa
  só gera erro e pode marcar anomalia na conta.
- **Não** inventar andares vazios para "aparecer sala". Um andar sem agente não é uma sala real e o servidor valida a
  plausibilidade.

## O que muda quando o World aceitar

Quando o protocolo público e o servidor aceitarem `opencode`, a mudança local é pequena e já está mapeada:

1. `shared/world/schema.json`: incluir `"opencode"` no enum de `provider`.
2. `shared/world/protocol.ts`: incluir `'opencode'` em `WorldAgent.provider`.
3. `shared/world/projection.ts`: parar de descartar agentes `opencode` e preservar o `provider` no pacote.
4. `shared/world/office-from-world.ts`: mostrar a conta fictícia do OpenCode quando houver agente dele na visita.
5. Servidor do World (repositório privado): aceitar o novo valor no schema copiado e desenhar o selo/visual do
   OpenCode; sem isso, o cliente local sozinho não resolve.
6. Testes: projeção com um agente OpenCode, schema aceitando o valor, visita com a conta OpenCode e o `ack` real.

## Como verificar depois

1. Abrir uma sessão do OpenCode num projeto e deixá-la trabalhar.
2. Conferir `~/.habblaud/world-last-uplink.json`: `uplink.floors` deve ser ≥ 1 e `uplink.floors[0].agents` deve
   incluir um `provider: "opencode"`.
3. Conferir o `ack.ok: true` e o prédio no World com o andar/sala.
4. Se o `ack` recusar, voltar a filtrar OpenCode no uplink e registrar o erro — não insistir.
