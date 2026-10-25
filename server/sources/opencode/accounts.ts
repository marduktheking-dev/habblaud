// Conta do OpenCode: o OpenCode é uma instalação global (ao contrário do Claude Code e do Codex, que têm um config
// dir por conta), então normalmente há UMA conta. Quem manda os eventos é o plugin local (server/sources/opencode/
// source.ts), que já entrega o id da sessão e a pasta do projeto; a conta aqui serve para rotular a origem.
//
// Pasta: $XDG_CONFIG_HOME/opencode (ou $HOME/.config/opencode), caindo para o data dir ($HOME/.local/share/opencode)
// quando só ele existe. HABBLAUD_OPENCODE_DIRS (lista separada por vírgula) substitui a descoberta e permite mais de
// uma conta, igual às outras ferramentas. Node puro e sem dependências do servidor.
//
// Privacidade: NUNCA lê o banco (opencode.db) nem credenciais; só confere se as pastas existem. Dos arquivos de shell,
// só as linhas `alias X='... opencode ...'`.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function xdg(env: NodeJS.ProcessEnv, variable: string, fallback: string, home: string): string {
  const raw = env[variable]?.trim();
  return raw ? expandHome(raw, home) : join(home, fallback);
}

/** Config dir do OpenCode: $XDG_CONFIG_HOME/opencode ou $HOME/.config/opencode. */
export function defaultOpenCodeHome(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string {
  return join(xdg(env, 'XDG_CONFIG_HOME', '.config', home), 'opencode');
}

/** Data dir do OpenCode (onde fica o opencode.db): $XDG_DATA_HOME/opencode ou $HOME/.local/share/opencode. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string {
  return join(xdg(env, 'XDG_DATA_HOME', join('.local', 'share'), home), 'opencode');
}

/**
 * Pastas observadas (uma conta por pasta). HABBLAUD_OPENCODE_DIRS substitui a descoberta; senão o config dir (padrão)
 * e, só se ele não existir, o data dir. Como o OpenCode é global, o normal é uma pasta só.
 */
export function discoverOpenCodeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_OPENCODE_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const config = defaultOpenCodeHome(env, home);
  if (isDir(config)) return [config];
  const data = opencodeDataDir(env, home);
  if (isDir(data)) return [data];
  return [];
}

/** Overrides das contas do OpenCode em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function opencodeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'opencode');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta sem alias: O (OpenCode), depois K, P, Q... e o alfabeto. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?opencode[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('O', 'K', 'P', 'Q', 'J', 'R');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface OpenCodeDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas contas das outras ferramentas (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por pasta do OpenCode, NA MESMA ORDEM de `dirs`. Sem e-mail nem plano (não saem sem ler credenciais; o
 * OpenCode não expõe isso pelos eventos) e com `configDir` para exibição (no Docker, o do host, vindo de
 * HABBLAUD_ACCOUNTS).
 */
export function detectOpenCodeAccounts(dirs: string[], opts: OpenCodeDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = opencodeOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'opencode'), home, defaultOpenCodeHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set<string>(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    return {
      id: p.id,
      provider: 'opencode',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `OpenCode ${short}` : 'OpenCode'),
      color,
    };
  });
}
