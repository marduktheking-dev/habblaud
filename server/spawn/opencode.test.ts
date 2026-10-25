import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenCodeCliRunner, openCodeArgs } from './opencode';

describe('novo agente no OpenCode', () => {
  it('cria uma sessão nova (sem --session) com o título da pasta, não com o pedido', () => {
    expect(openCodeArgs({ folder: '/p/projetos', prompt: '  arrume o teste  \n' })).toEqual(['run', '--title', 'Habblaud: projetos']);
    expect(openCodeArgs({ folder: '/p/projetos/', prompt: '' })).toEqual(['run', '--title', 'Habblaud: projetos']);
    expect(openCodeArgs({ folder: '/', prompt: 'oi' })).toEqual(['run', '--title', 'Habblaud: projeto']);
  });

  it('sem pedido, recusa em vez de abrir uma sessão vazia', async () => {
    const run = createOpenCodeCliRunner('/bin/true');
    expect(await run({ folder: '/p', prompt: '   ' })).toEqual({ ok: false, error: 'o OpenCode precisa de um pedido para começar uma sessão nova' });
  });

  it('com pedido, manda o texto pela entrada padrão e o título pelos argumentos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-opencode-'));
    const bin = join(dir, 'opencode-falso');
    writeFileSync(bin, '#!/bin/sh\ncat > prompt.txt\nprintf \'%s\\n\' "$@" > args.txt\nprintenv PWD > envpwd.txt\n');
    chmodSync(bin, 0o755);
    const run = createOpenCodeCliRunner(bin, 2_000);
    const r = await run({ folder: dir, prompt: '  faça X  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    await new Promise((ok) => setTimeout(ok, 150));
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe('  faça X  ');
    expect(readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n')).toEqual(['run', '--title', `Habblaud: ${basename(dir)}`]);
    expect(readFileSync(join(dir, 'envpwd.txt'), 'utf8').trim()).toBe(dir);
  });
});
