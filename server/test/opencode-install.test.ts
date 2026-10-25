// Instalador do plugin do OpenCode (scripts/opencode-install.ts): instala/remove/status sem tocar no que é de
// outros plugins, com backup antes de regravar e a porta gravada em ~/.habblaud/opencode-plugin.json.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_SRC, configPath, parseArgs, pluginDest, readPluginConfig, run, type RunContext } from '../../scripts/opencode-install';

const ROOT = mkdtempSync(join(tmpdir(), 'habblaud-open-'));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

/** Uma casa falsa + uma pasta de conta do OpenCode, isoladas por teste. */
function setup() {
  const home = join(ROOT, `${Math.random().toString(36).slice(2)}`);
  const dir = join(home, '.config', 'opencode');
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const ctx: RunContext = { env: { HABBLAUD_OPENCODE_DIRS: dir }, home, out: (l) => lines.push(l) };
  return { home, dir, lines, ctx, src: readFileSync(PLUGIN_SRC, 'utf8') };
}

function backups(dir: string): string[] {
  const plugins = join(dir, 'plugins');
  return existsSync(plugins) ? readdirSync(plugins).filter((f) => f.includes('habblaud-backup')) : [];
}

describe('opencode-install.ts', () => {
  it('instala o plugin, grava a url e não mexe em outros plugins', async () => {
    const { home, dir, lines, ctx, src } = setup();
    const other = join(dir, 'plugins', 'outro-plugin.ts');
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(other, '// outro plugin');

    const code = await run({ cmd: 'install', port: 45999 }, ctx);
    expect(code).toBe(0);
    expect(readFileSync(pluginDest(dir), 'utf8')).toBe(src);
    expect(readFileSync(other, 'utf8')).toBe('// outro plugin');
    expect(readPluginConfig(home)).toEqual({ url: 'http://127.0.0.1:45999' });
    expect(lines.join('\n')).toContain('plugin instalado');
    // O Habblaud não responde nessa porta: o aviso sai, mas a instalação continua.
    expect(lines.join('\n')).toContain('45999');
  });

  it('rodar de novo sem mudanças não regrava nem duplica', async () => {
    const { dir, ctx } = setup();
    await run({ cmd: 'install', port: 45999 }, ctx);
    const code = await run({ cmd: 'install', port: 45999 }, ctx);
    expect(code).toBe(0);
    expect(backups(dir)).toHaveLength(0);
    const pluginDir = join(dir, 'plugins');
    expect(readdirSync(pluginDir).filter((f) => f === 'habblaud-events.ts')).toHaveLength(1);
  });

  it('ao regravar conteúdo diferente, guarda backup antes', async () => {
    const { dir, ctx, src } = setup();
    await run({ cmd: 'install', port: 45999 }, ctx);
    writeFileSync(pluginDest(dir), '// versão antiga do plugin');
    await run({ cmd: 'install', port: 45999 }, ctx);
    expect(readFileSync(pluginDest(dir), 'utf8')).toBe(src);
    const bkp = backups(dir);
    expect(bkp).toHaveLength(1);
    expect(readFileSync(join(dir, 'plugins', bkp[0]!), 'utf8')).toBe('// versão antiga do plugin');
  });

  it('--dry-run não grava nada', async () => {
    const { home, dir, ctx } = setup();
    const code = await run({ cmd: 'install', port: 45999, dryRun: true }, ctx);
    expect(code).toBe(0);
    expect(existsSync(pluginDest(dir))).toBe(false);
    expect(readPluginConfig(home)).toBeUndefined();
  });

  it('uninstall remove só o plugin do Habblaud (com backup)', async () => {
    const { dir, ctx } = setup();
    await run({ cmd: 'install', port: 45999 }, ctx);
    const code = await run({ cmd: 'uninstall', port: 45999 }, ctx);
    expect(code).toBe(0);
    expect(existsSync(pluginDest(dir))).toBe(false);
    expect(backups(dir)).toHaveLength(1);
  });

  it('uninstall de quem não estava instalado avisa e sai bem', async () => {
    const { dir, lines, ctx } = setup();
    const code = await run({ cmd: 'uninstall', port: 45999 }, ctx);
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('não estava instalado');
    expect(backups(dir)).toHaveLength(0);
  });

  it('recusa uma pasta sem conta do OpenCode com --conta', async () => {
    const { lines, ctx } = setup();
    const code = await run({ cmd: 'status', port: 45999, account: 'nao-existe' }, ctx);
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Nenhuma pasta do OpenCode com o nome nao-existe.');
  });

  it('status diz se o plugin está instalado e igual ao repositório', async () => {
    const { dir, ctx } = setup();
    await run({ cmd: 'install', port: 45999 }, ctx);
    const lines: string[] = [];
    await run({ cmd: 'status', port: 45999 }, { ...ctx, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain('instalado');
    writeFileSync(pluginDest(dir), '// mexido à mão');
    const lines2: string[] = [];
    await run({ cmd: 'status', port: 45999 }, { ...ctx, out: (l) => lines2.push(l) });
    expect(lines2.join('\n')).toContain('diferente do repositório');
  });

  it('sem pasta nenhuma (nem a padrão), explica e falha', async () => {
    const home = join(ROOT, 'vazio');
    mkdirSync(home, { recursive: true });
    const lines: string[] = [];
    const code = await run({ cmd: 'status', port: 45999 }, { env: {}, home, out: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Nenhuma pasta do OpenCode');
  });

  it('pluginDest e configPath ficam onde o plugin/servidor esperam', () => {
    expect(pluginDest('/x/opencode')).toBe(join('/x/opencode', 'plugins', 'habblaud-events.ts'));
    expect(basename(configPath('/casa'))).toBe('opencode-plugin.json');
    expect(configPath('/home/u')).toBe(join('/home/u', '.habblaud', 'opencode-plugin.json'));
  });
});

describe('parseArgs', () => {
  it('lê o comando, as opções e a porta (env primeiro)', () => {
    expect(parseArgs([], {})).toBe('help');
    expect(parseArgs(['install'], {})).toEqual({ cmd: 'install', dryRun: false, account: undefined, port: 4747 });
    expect(parseArgs(['--dry-run', 'status', '--conta', 'opencode', '--port', '5000'], {})).toEqual({ cmd: 'status', dryRun: true, account: 'opencode', port: 5000 });
    expect(parseArgs(['install'], { HABBLAUD_PORT: '5555' })).toMatchObject({ cmd: 'install', port: 5555 });
  });

  it('ignore comandos desconhecidos e devolve ajuda', () => {
    expect(parseArgs(['fazer'], {})).toBe('help');
    expect(parseArgs(['--help'], {})).toBe('help');
  });
});
