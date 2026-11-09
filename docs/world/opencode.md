# OpenCode no Habblaud World: por que o prédio fica sem andares

**Estado em 26/10/2026:** o gate está implementado e armado. Ele fecha sozinho enquanto o contrato público do World
não aceitar `opencode`, e abre sozinho no dia em que aceitar — sem mexer em código.

O escritório local mostra as sessões do OpenCode normalmente (sala, personagem, conversa e totais). O que sobe ao World
é o pacote do prédio, e o `provider` dele só pode ser o que o contrato remoto valida: hoje `["claude", "codex"]`. Um
prédio com só agentes do OpenCode sobe com `floors: []`; o `ack` vem `ok: true` porque o pacote é válido, mas não há
andar para mostrar.

## Evidência

- `shared/world/schema.json` e o `main` público (lidos pela sonda em 26/10/2026): o enum de `provider` publicado é
  `["claude", "codex"]`. A cópia local do enum já está preparada com `"opencode"`, mas é o gate — não o schema local —
  que decide o que sai.
- O PR upstream #139 ("Add experimental OpenCode v2 sessions to the office") diz explicitamente: "Agentes OpenCode não
  são enviados como Claude ao Habblaud World, cujo protocolo ainda suporta apenas Claude/Codex."
- `~/.habblaud/world-last-uplink.json` depois de reiniciar o serviço: `ack.ok: true`, `uplink.floors: 0`,
  `uplink.agents: 0`. O World está conectado (conta aprovada), mas sem andares.
- `server.habblaud.com` (o cliente do mundo) não traz `opencode` como valor de `provider` em nenhum bundle; análise
  passiva com o REA (`rea analyze-web-bundle`/fetch estático em 27/10/2026).

## O gate: quatro barreiras, todas precisam estar abertas

Arquivo central: `shared/world/opencode-gate.ts` (puro, sem rede nem Node). Qualquer barreira fechada devolve o
conjunto publicado `claude|codex` — o pacote continua exatamente como hoje, sem risco de recusa.

| # | Barreira | Onde vive |
|---|---|---|
| 1 | Flag ligada (`HABBLAUD_WORLD_OPENCODE`; `=0` fecha) | `server/config.ts` → `config.worldOpenCode` |
| 2 | Leitura do contrato remoto fresca (≤ 7 h) e observada **duas vezes** com `opencode` | `server/world/schema-probe.ts` |
| 3 | O enum remoto contém `"opencode"` | `server/world/schema-probe.ts` → `providerEnumOf` |
| 4 | O servidor não recusou a última remessa por `schema`/`implausible` (fecha por 6 h) | `server/world/uplink.ts` → `cutFromAck` |

A sonda (`server/world/schema-probe.ts`) lê `shared/world/schema.json` do repositório público
(`raw.githubusercontent.com/.../main/...`) a cada 6 h com ETag, guarda em `<dataDir>/world-schema.json` e nunca
levanta erro: leitura ruim = gate fechado. Ela fala com o repositório público, nunca com o servidor do mundo e nunca
com uma conta.

O que sai daí:

- `shared/world/projection.ts` recebe `worldProviders` (a interseção do que o Habblaud sabe representar com o que o
  contrato remoto aceita) e **não converte** provider nenhum: quem não passa no filtro fica de fora, e o agente do
  OpenCode continua normalmente no escritório local.
- `server/world/uplink.ts` publica o estado do gate em `WorldBuildingStatus.opencode`
  (`/api/world/status` → `building.opencode`): `allowed`, `reason` (`open`, `flag_off`, `unknown_remote`,
  `remote_denied`, `ack_cut`), `providers`, `checkedAt`, `probeError` e `cut`.
- `client/src/ui/world/world-model.ts` põe uma linha no cartão "Seu prédio" explicando o motivo — um `0` mudo não
  explica nada.
- `shared/world/office-from-world.ts` já sabe renderizar um prédio de fora que traga `provider: "opencode"` (sem criar
  conta vazia quando não há agente dele).

## O que NÃO se faz (continua valendo)

- **Não** mapear OpenCode para `claude` ou `codex`. O campo `provider` é a ferramenta que está rodando; trocar o valor
  seria mentir sobre os dados e quebra os termos do World (dados verdadeiros).
- **Não** mandar `provider: "opencode"` enquanto o contrato publicado não o aceitar. O pacote inteiro é recusado;
  repetir a remessa só gera erro e pode marcar anomalia na conta — é justamente o que a barreira 3 e a 4 impedem.
- **Não** inventar andares vazios para "aparecer sala". Um andar sem agente não é uma sala real e o servidor valida a
  plausibilidade.

## O que acontece sozinho quando o World aceitar

Nada de código novo. O ciclo é:

1. O repositório público passa a publicar `"opencode"` no enum de `provider`.
2. A sonda lê essa mudança na próxima volta (≤ 6 h) e, na segunda leitura seguida com o valor, o gate abre.
3. O uplink reprojeta com `worldProviders = ["claude", "codex", "opencode"]`, manda e o agente do OpenCode vira andar.
4. Se o servidor recusar assim mesmo (`ack` `schema` ou `implausible`), a barreira 4 fecha por 6 h e o prédio volta ao
   contrato anterior — uma recusa, nunca uma repetição.

Para forçar a reavaliação sem esperar a sonda, reinicie o serviço (`sv restart habblaud`): a leitura guardada vale e é
reconfirmada; para uma leitura imediata, apague `<dataDir>/world-schema.json`.

## Como verificar

1. Estado do gate: `curl -H 'Host: localhost:4747' http://127.0.0.1:4747/api/world/status` →
   `building.opencode.reason` (hoje esperado: `remote_denied`).
2. No cartão "Seu prédio", a linha "OpenCode fora do prédio: ..." diz o mesmo motivo.
3. Quando abrir: abrir uma sessão do OpenCode num projeto e conferir `~/.habblaud/world-last-uplink.json` —
   `uplink.floors` ≥ 1 e um agente com `provider: "opencode"`, com `ack.ok: true`.
4. Se o `ack` recusar: o gate fecha sozinho (`reason: "ack_cut"`) e o pacote volta a ser só `claude|codex`. Não
   insistir — registrar o erro e esperar a sonda confirmar de novo.

Testes: `shared/world/opencode-gate.test.ts`, `server/world/schema-probe.test.ts`, o bloco "o gate decide quem tem
provider no pacote" em `shared/world/projection.test.ts` e o bloco "o gate do OpenCode no pacote e no status" em
`server/world/uplink.test.ts`.

## Adaptador de fio (opt-in): `HABBLAUD_WORLD_OPENCODE_ADAPTER`

Enquanto o contrato público prepara o `opencode`, existe um caminho intermediário **explícito e reversível**: remapear
apenas o rótulo `provider` no pacote enviado, mantendo a verdade local intacta.

| variável | efeito |
|---|---|
| ausente / `off` / `0` / `false` | desligado (padrão; o agente OpenCode fica fora do prédio) |
| `codex` ou `claude` | agentes OpenCode saem no fio com esse provider |
| `1` / `true` / `on` / `yes` | igual a `codex` |

O que o adaptador faz e o que **não** faz:

- muda só `provider` no JSON enviado (`shared/world/projection.ts` → `opencodeWireProvider`); contagem, andar, nome,
  status e tarefas continuam os reais;
- a fonte da verdade continua local: `AgentInfo.provider` segue `opencode` no escritório, no snapshot e na tela;
- a rota inversa existe (`unadaptWorldProvider`) para quem lê o pacote adaptado e precisa voltar ao valor original;
- só age quando o gate **não** aceita `opencode` e aceita o alias (`canAdaptOpenCode`);
- cada remessa adaptada registra um aviso único no log: `world-opencode-adapter`.

Risco aceito e por quê: o rótulo no fio deixa de dizer a ferramenta real. É uma escolha do operador para ver o
andamento do prédio antes de o contrato público aceitar `opencode` — não é o padrão, é reversível (`sv restart` depois
de tirar a variável) e não altera dado local nenhum. Quando a barreira 3 abrir, o adaptador para de agir sozinho,
porque `opencode` passa a estar em `worldProviders` e o remapeamento deixa de ser necessário.

## Override de desenvolvimento: `HABBLAUD_WORLD_OPENCODE_TRUST_LOCAL`

Para testar o caminho nativo sem depender do servidor público: com `--dev` (ou `HABBLAUD_WORLD_DEV=1`), alvo `http://`
e `HABBLAUD_WORLD_OPENCODE_TRUST_LOCAL=1`, o gate trata o contrato local como se publicasse `opencode`. Só vale para
servidor local (`127.0.0.1`/`host.docker.internal`) — nunca contra `https` público, justamente para não provocar
`ack` `schema`/`ack_cut` na conta real.

## Motivos do gate em `/api/world/status`

| `reason` | significado |
|---|---|
| `open` | contrato remoto aceita `opencode`; agentes entram com o provider original |
| `flag_off` | `HABBLAUD_WORLD_OPENCODE=0` fechou a barreira 1 |
| `unknown_remote` | sem leitura fresca/dupla do contrato; fail-safe |
| `remote_denied` | contrato publicado ainda é `["claude","codex"]` |
| `ack_cut` | o servidor recusou a última remessa por `schema`/`implausible`; fecha por 6 h |
