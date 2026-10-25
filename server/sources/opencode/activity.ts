// Traduz o NOME de uma ferramenta do OpenCode numa atividade legível (mesmo formato do shared/activity.ts).
//
// O plugin do OpenCode manda só o NOME da ferramenta (nunca os argumentos: comandos, caminhos, diffs), então o
// texto é sempre genérico: nada do conteúdo da sessão entra no escritório. Código puro e sem dependências do
// servidor, como o resto do catálogo de atividades.
import type { ActivityDescription } from '../../../shared/activity';
import type { ActivityKind } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Atividade da ferramenta do OpenCode: o nome bruto vai em `tool` (sem tradução). */
export type OpenCodeToolActivity = ActivityDescription & { tool?: string };

interface Rule {
  /** Casa com o nome em minúsculas (primeira regra que casar vence). */
  re: RegExp;
  kind: ActivityKind;
  icon: string;
  text: () => string;
}

// A ordem importa: o mais específico primeiro (ex.: "todoread" é 'plan', não 'read'; "task" antes de "ask").
// Os textos reaproveitam as strings já existentes do catálogo do Claude Code quando o sentido é o mesmo.
const RULES: readonly Rule[] = [
  { re: /^mcp[_:.]|(^|[_:.])mcp/, kind: 'mcp', icon: '🔌', text: () => tr('Usando uma ferramenta MCP') },
  { re: /todo|checklist|plan_?list/, kind: 'plan', icon: '🗒️', text: () => tr('Planejando') },
  { re: /task|subagent|delegate|spawn_?agent/, kind: 'delegate', icon: '👥', text: () => tr('Chamando um subagente') },
  { re: /skill/, kind: 'skill', icon: '🧩', text: () => tr('Usando uma habilidade') },
  { re: /webfetch|websearch|fetch|browse|https?|url/, kind: 'web', icon: '🌐', text: () => tr('Acessando a web') },
  { re: /grep|search|\brg\b|query/, kind: 'search', icon: '🔎', text: () => tr('Buscando no código') },
  { re: /glob|\blist\b|\bls\b|find|tree|dir/, kind: 'search', icon: '🔎', text: () => tr('Explorando pastas') },
  { re: /read|view|\bcat\b|open|\bget\b|show/, kind: 'read', icon: '📖', text: () => tr('Lendo arquivo') },
  { re: /write|create|save|new_file/, kind: 'write', icon: '📝', text: () => tr('Escrevendo um arquivo') },
  { re: /edit|patch|replace|apply|modify|multiedit|str_?replace/, kind: 'edit', icon: '✏️', text: () => tr('Editando arquivo') },
  { re: /test|vitest|jest|pytest|spec/, kind: 'test', icon: '🧪', text: () => tr('Rodando testes') },
  { re: /\bgit\b|commit|diff|branch|status_?short/, kind: 'git', icon: '🌿', text: () => tr('Usando o git') },
  { re: /shell|bash|terminal|exec|command|process|\bpty\b|\brun\b/, kind: 'run', icon: '💻', text: () => tr('Rodando um comando no terminal') },
];

/** Atividade de uma ferramenta do OpenCode só pelo nome (sem argumentos). */
export function describeOpenCodeTool(raw: string | undefined): OpenCodeToolActivity {
  const name = raw?.trim();
  const key = name?.toLowerCase() ?? '';
  const rule = key ? RULES.find((r) => r.re.test(key)) : undefined;
  const desc: OpenCodeToolActivity = rule
    ? { kind: rule.kind, icon: rule.icon, text: rule.text() }
    : { kind: 'other', icon: '🔧', text: tr('Usando uma ferramenta') };
  if (name) desc.tool = name;
  return desc;
}
