// Instala (ou remove) o plugin de eventos do Habblaud no OpenCode. Roda no HOST, com tsx:
//
//   npm run opencode:install     # copia mod/habblaud-opencode/plugin.ts para <pasta>/plugins/habblaud-events.ts
//   npm run opencode:uninstall   # tira só o plugin do Habblaud (os outros plugins ficam); faz backup antes
//   npm run opencode:status      # mostra, por pasta, se o plugin está lá e se o Habblaud está respondendo
//   (opções: --dry-run, --conta <id>, --port <n>)
//
// O plugin (mod/habblaud-opencode/plugin.ts) fica no processo compartilhado do OpenCode (`opencode serve
// --service`) e manda ao escritório só o que muda QUEM está trabalhando (sessão, turno, ferramenta, estado de
// execução, pedido de permissão): só ids, a pasta do projeto, o nome da ferramenta, o agente e o modelo — nunca
// o prompt, a resposta, os argumentos das ferramentas, tokens ou credenciais. O modelo escolhido nunca é tocado.
//
// Pastas: as mesmas contas do OpenCode que o servidor acompanha: HABBLAUD_OPENCODE_DIRS (lista separada por
// vírgula; substitui tudo) ou $XDG_CONFIG_HOME/opencode e ~/.config/opencode (com o data dir como reserva). Pasta
// do Claude Code fica de fora. A porta fica em ~/.habblaud/opencode-plugin.json ({ "url": ... }, que o plugin lê):
// mudar a porta não pede reinstalar o plugin. Rodar de novo não duplica: só regrava se o conteúdo mudou.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaudeDir } from '../server/accounts/detect';
import { discoverOpenCodeDirs } from '../server/sources/opencode/accounts';
import { tildify } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_SRC = join(ROOT, 'mod', 'habblaud-opencode', 'plugin.ts');
export const PLUGIN_NAME = 'habblaud-events.ts';
export const CONFIG_NAME = 'opencode-plugin.json';
export const DEFAULT_PORT = 4747;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

const USAGE = tr(
  'Uso: npm run opencode:<install|uninstall|status> [-- opções]\n\n  install     copia o plugin do Habblaud para a pasta de plugins de cada conta do OpenCode (faz backup antes)\n  uninstall   tira o plugin do Habblaud de cada pasta (os outros plugins ficam)\n  status      mostra se o plugin está lá e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --conta <id>     só a pasta desta conta (o nome da pasta, ex.: opencode)\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  -h, --help       mostra esta ajuda\n\nPastas: HABBLAUD_OPENCODE_DIRS (lista separada por vírgula) ou $XDG_CONFIG_HOME/opencode e ~/.config/opencode.\nDepois de instalar, o plugin só vale para as sessões do OpenCode abertas depois.',
  [DEFAULT_PORT],
);

export interface RunOptions {
  cmd: 'install' | 'uninstall' | 'status';
  dryRun?: boolean;
  account?: string;
  port: number;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  out: (line: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/opencode-install.test.ts)
// ---------------------------------------------------------------------------------------------

export function pluginDest(dir: string): string {
  return join(dir, 'plugins', PLUGIN_NAME);
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

/** URL do Habblaud para a porta escolhida. */
export function habblaudUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Configuração gravada para o plugin (undefined = não existe, ilegível ou sem url). */
export function readPluginConfig(home: string): { url?: string } | undefined {
  try {
    const j = rec(JSON.parse(readFileSync(configPath(home), 'utf8')));
    if (!j) return undefined;
    const out: { url?: string } = {};
    if (typeof j.url === 'string') out.url = j.url;
    return out;
  } catch {
    return undefined;
  }
}

/** Pastas do OpenCode a considerar (as mesmas do servidor), com o filtro de conta e o aviso do Claude Code. */
export function opencodeDirs(opts: RunOptions, ctx: RunContext): { dirs: string[]; refused: string[] } {
  const refused: string[] = [];
  const dirs: string[] = [];
  for (const p of discoverOpenCodeDirs(ctx.env, ctx.home)) (isClaudeDir(p) ? refused : dirs).push(p);
  return { dirs: opts.account ? dirs.filter((d) => basename(d) === opts.account) : dirs, refused };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readSource(): string {
  if (!existsSync(PLUGIN_SRC)) throw new Error(tr('não achei o plugin em {0}', [tildify(PLUGIN_SRC, homedir())]));
  return readFileSync(PLUGIN_SRC, 'utf8');
}

interface Health {
  ok?: boolean;
  opencodeEvents?: boolean;
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    return res.ok ? ((await res.json()) as Health) : undefined;
  } catch {
    return undefined;
  }
}

/** Grava ~/.habblaud/opencode-plugin.json (sem regravar à toa). Devolve true se gravou. */
export function writePluginConfig(home: string, url: string): boolean {
  if (readPluginConfig(home)?.url === url) return false;
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify({ url }, null, 2)}\n`, { mode: 0o644 });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------------------------

export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { home } = ctx;
  const { dirs, refused } = opencodeDirs(opts, ctx);
  for (const p of refused) ctx.out(tr('! {0}: é uma pasta do Claude Code, não do OpenCode; fica de fora.', [tildify(p, home)]));
  if (!dirs.length) {
    ctx.out(
      opts.account
        ? tr('Nenhuma pasta do OpenCode com o nome {0}.', [opts.account])
        : tr('Nenhuma pasta do OpenCode encontrada (XDG_CONFIG_HOME/opencode ou ~/.config/opencode). Use HABBLAUD_OPENCODE_DIRS se ela estiver em outro lugar.'),
    );
    return 1;
  }

  const url = habblaudUrl(opts.port);

  if (opts.cmd === 'install') {
    const src = readSource();
    if (opts.dryRun) ctx.out(tr('(ensaio) gravaria {0}.', [tildify(configPath(home), home)]));
    else if (writePluginConfig(home, url)) ctx.out(tr('Configuração: {0} ({1})', [tildify(configPath(home), home), url]));
    for (const dir of dirs) {
      const dest = pluginDest(dir);
      const cur = existsSync(dest) ? readFileSync(dest, 'utf8') : undefined;
      if (cur === src) {
        ctx.out(tr('= {0}: já está igual.', [tildify(dest, home)]));
        continue;
      }
      if (opts.dryRun) {
        ctx.out(tr('(ensaio) gravaria {0}.', [tildify(dest, home)]));
        continue;
      }
      if (cur !== undefined) {
        const backup = `${dest}.habblaud-backup-${stamp()}`;
        writeFileSync(backup, cur);
        ctx.out(tr('~ backup: {0}', [tildify(backup, home)]));
      }
      mkdirSync(join(dir, 'plugins'), { recursive: true });
      writeFileSync(dest, src);
      ctx.out(tr('+ {0}: plugin instalado.', [tildify(dest, home)]));
    }
    const health = await fetchHealth(opts.port);
    if (!health) ctx.out(tr('! O Habblaud não respondeu em {0}; abra-o antes de usar o OpenCode.', [url]));
    else if (!health.opencodeEvents) ctx.out(tr('! O Habblaud está no ar, mas as rotas do OpenCode estão desligadas (HABBLAUD_OPENCODE=0?).'));
    else ctx.out(tr('Ok: o Habblaud está no ar e recebendo eventos do OpenCode em {0}.', [url]));
    return 0;
  }

  if (opts.cmd === 'uninstall') {
    for (const dir of dirs) {
      const dest = pluginDest(dir);
      if (!existsSync(dest)) {
        ctx.out(tr('= {0}: não estava instalado.', [tildify(dest, home)]));
        continue;
      }
      if (opts.dryRun) {
        ctx.out(tr('(ensaio) removeria {0}.', [tildify(dest, home)]));
        continue;
      }
      const backup = `${dest}.habblaud-backup-${stamp()}`;
      writeFileSync(backup, readFileSync(dest, 'utf8'));
      rmSync(dest, { force: true });
      ctx.out(tr('- {0}: plugin removido (backup em {1}).', [tildify(dest, home), tildify(backup, home)]));
    }
    return 0;
  }

  // status
  const src = existsSync(PLUGIN_SRC) ? readFileSync(PLUGIN_SRC, 'utf8') : undefined;
  ctx.out(tr('Configuração: {0} ({1})', [tildify(configPath(home), home), readPluginConfig(home)?.url ?? tr('sem url; o plugin usa HABBLAUD_URL')]));
  for (const dir of dirs) {
    const dest = pluginDest(dir);
    if (!existsSync(dest)) ctx.out(tr('! {0}: sem o plugin do Habblaud.', [tildify(dest, home)]));
    else if (src !== undefined && readFileSync(dest, 'utf8') !== src) ctx.out(tr('~ {0}: instalado, mas diferente do repositório (rode opencode:install).', [tildify(dest, home)]));
    else ctx.out(tr('+ {0}: instalado.', [tildify(dest, home)]));
  }
  const health = await fetchHealth(opts.port);
  ctx.out(health ? tr('Habblaud: no ar em {0}.', [url]) : tr('Habblaud: sem resposta em {0}.', [url]));
  return 0;
}

/** Interpreta os argumentos (exportada para os testes). */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let cmd: RunOptions['cmd'] | undefined;
  let dryRun = false;
  let account: string | undefined;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--conta' || a === '--account') account = argv[++i];
    else if (a === '--port') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) port = n;
    } else if (cmd === undefined && (a === 'install' || a === 'uninstall' || a === 'status')) cmd = a;
  }
  if (!cmd) return 'help';
  return { cmd, dryRun, account, port };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const code = await run(parsed, { env: process.env, home: homedir(), out: (l) => process.stdout.write(`${l}\n`) });
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
