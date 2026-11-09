# Voz: falar com os agentes pelo nome

Integração da estação com o projeto separado
[`voz-agente`](https://github.com/marduktheking-dev/voz-agente): transcreve a fala localmente, resolve o **nome que o
Habblaud deu ao agente** em `/api/snapshot` e entrega em `POST /api/messages`. A resposta é narrada em voz.

O Habblaud **não** embute STT/TTS: ele expõe os dois contratos que a voz usa — o snapshot (quem está no escritório, com
que nome) e a fila de mensagens (entrega na sessão certa). O `voz-agente` é um cliente desses contratos, sem estado.

```
voz-agente  ──GET /api/snapshot──►  nome → agentId
            ──POST /api/messages─►  {agentId, text}
            ──GET /api/snapshot──►  atividade recente → TTS
```

## Contratos usados

| rota | uso |
|---|---|
| `GET /api/snapshot` | `agents[].name` (nome do personagem), `id`, `status`, `kind`, `account` |
| `POST /api/messages` | corpo `{agentId, text}`; resposta `201` com `{id, status: "queued"}` |
| `GET /api/messages/:id` | `queued` → `sent` → `delivered` / `failed` |

Entrega no OpenCode: `opencode run --session <id>` com o texto na entrada padrão. O CLI precisa estar no `PATH` de
quem roda o Habblaud (o log mostra a linha `Mensagens ao OpenCode: …`). Sem o CLI, o snapshot não marca `canMessage`.

## Duas formas de ditar

1. **Navegador (ditado do Habblaud)** — botão de microfone no campo de mensagem: grava, manda para
   `POST /api/dictation`, transcreve com o whisper local (`HABBLAUD_WHISPER_BIN`/`HABBLAUD_WHISPER_MODEL`) e **insere o
   texto no campo**. O envio é manual.
2. **Terminal (`voz-agente`)** — `termux-speech-to-text` ou gravação + whisper, resolução do nome e envio em um comando.

## Instalação na estação

```bash
git clone https://github.com/marduktheking-dev/voz-agente.git ~/ia-estacao/voz-agente
node ~/ia-estacao/voz-agente/bin/voz-agente.mjs --listar
node ~/ia-estacao/voz-agente/bin/voz-agente.mjs            # fale: "agente Francisco, <comando>"
```

Atalhos preservados por symlink em `~/ia-estacao/projetos/`: `voz-agente.mjs`, `voz-agente`, `VOZ-AGENTE.md` e `voz`.

Dependências de voz no Termux: `pkg install termux-api` + app **Termux:API** com Microfone permitido; ou
`whisper-cli` + `ggml-base.bin` para STT offline; `espeak`/`sox` como TTS de reserva.

## Depuração rápida

| sintoma | conferir |
|---|---|
| lista vazia | sessão aberta no OpenCode; `grep 'Mensagens ao OpenCode' ~/ia-estacao/habblaud.log \| tail -1` |
| `queued` que não vira `delivered` | PATH do serviço apontando para CLI falso (`.../tmp/fakebin/...`) |
| nome não encontrado | `--listar` mostra o nome real do personagem, não o id |
| sem áudio no TTS | `termux-tts-engines`; ou `espeak`/`play` presentes |
