// Sonda do contrato publicado do Habblaud World: lê shared/world/schema.json do repositório público e devolve o
// `provider.enum` que o servidor do mundo valida hoje — é a barreira que decide se um agente do OpenCode pode entrar
// no pacote do prédio (shared/world/opencode-gate.ts).
//
// Mesmo modelo do UpdateChecker (server/updates/checker.ts): uma leitura a cada 6 h (1 h depois de falha) com ETag, o
// resultado guardado em <dataDir>/world-schema.json para um reinício não repetir a consulta, e nunca um erro em excesso
// no log. Só leitura de um arquivo público; nada muda de lugar, nenhum dado deste computador sai aqui.
//
// O enum NÃO vem do servidor do mundo (que exige token): vem da fonte que o servidor copia (shared/world/README.md).
// Se a leitura não der para interpretar, o gate fica fechado (fail-safe): o pacote continua só com claude|codex.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';
import type { OpenCodeProbe } from '../../shared/world/opencode-gate';
import { parseGithubRepo } from '../updates/checker';

/** Uma leitura a cada 6 h (a folga do gate é 7 h). */
export const SCHEMA_PROBE_EVERY_MS = 6 * 3_600_000;
/** Depois de uma falha, tenta de novo em 1 h. */
export const SCHEMA_PROBE_RETRY_MS = 3_600_000;
/** Primeira leitura depois de subir (não atrasa a inicialização). */
const FIRST_DELAY_MS = 5_000;
const TIMEOUT_MS = 10_000;
/** Caminho do contrato dentro do repositório (é de lá que o servidor do mundo copia). */
export const SCHEMA_PATH = 'shared/world/schema.json';
/** Branch do repositório público. */
const BRANCH = 'main';

interface Cached {
  repo: string;
  checkedAt: number;
  etag?: string;
  providers?: string[];
  /** Leituras bem-sucedidas (qualquer conteúdo). */
  observations: number;
  /** Leituras seguidas que trouxeram "opencode" no enum (o gate exige 2 antes de abrir; sem o valor, zera). */
  opencodeObservations: number;
}

/** URL crua do contrato no repositório público (sem token, sem cookie, sem credencial nenhuma). */
export function schemaRawUrl(repo: string): string {
  return `https://raw.githubusercontent.com/${repo}/${BRANCH}/${SCHEMA_PATH}`;
}

/**
 * `provider.enum` do contrato, com formato conferido (tem que ser lista de strings). Qualquer coisa fora do esperado
 * derruba quem chamou: nunca devolve "acho que aceita".
 */
export function providerEnumOf(schema: unknown): string[] {
  const root = schema as Record<string, unknown> | null;
  const defs = root?.$defs as Record<string, unknown> | undefined;
  const agent = defs?.agent as Record<string, unknown> | undefined;
  const props = agent?.properties as Record<string, unknown> | undefined;
  const provider = props?.provider as Record<string, unknown> | undefined;
  const list = provider?.enum;
  if (!Array.isArray(list) || !list.length || list.some((v) => typeof v !== 'string')) {
    throw new Error('provider.enum ausente ou fora do formato em schema.json');
  }
  return [...new Set(list as string[])];
}

export interface WorldSchemaProbeOptions {
  /** "dono/nome" (package.json repository); ausente = sonda desligada. */
  repo?: string;
  /** HABBLAUD_WORLD_OPENCODE=0 desliga a leitura (o gate fica fechado por falta de leitura). */
  enabled: boolean;
  /** <dataDir>/world-schema.json; null = só em memória (testes). */
  file: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** A leitura mudou (o prédio pode precisar reenviar): o uplink reavalia o gate. */
  onChange?: () => void;
}

export class WorldSchemaProbe {
  private cache: Cached | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private lastAttempt = -Infinity;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: WorldSchemaProbeOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.opts.enabled && !!this.opts.repo;
  }

  /** O que o gate lê (nunca lança; sem leitura = sonda vazia = gate fechado). */
  get(): OpenCodeProbe {
    const c = this.cache;
    const out: OpenCodeProbe = c
      ? { checkedAt: c.checkedAt, observations: c.observations, opencodeObservations: c.opencodeObservations }
      : { observations: 0, opencodeObservations: 0 };
    if (c?.providers) out.providers = c.providers;
    if (this.lastError) out.error = this.lastError;
    return out;
  }

  /** Lê o último resultado guardado (ignorado se for de outro repositório). */
  load(): void {
    const { file, repo } = this.opts;
    if (!file || !repo) return;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<Cached>;
      if (j.repo !== repo || typeof j.checkedAt !== 'number' || !Number.isFinite(j.checkedAt)) return;
      this.cache = {
        repo,
        checkedAt: j.checkedAt,
        etag: typeof j.etag === 'string' ? j.etag.slice(0, 200) : undefined,
        providers: Array.isArray(j.providers) && j.providers.every((v) => typeof v === 'string') ? [...j.providers] : undefined,
        observations: typeof j.observations === 'number' && j.observations >= 0 ? j.observations : 0,
        opencodeObservations:
          typeof j.opencodeObservations === 'number' && j.opencodeObservations >= 0 ? j.opencodeObservations : 0,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('world-schema.json ilegível ({0}); lendo o contrato de novo.', [errMsg(err)]));
    }
  }

  /** Agenda a primeira leitura: logo depois de subir, ou quando a guardada vencer. */
  start(): void {
    if (!this.enabled) return;
    const due = this.cache ? this.cache.checkedAt + SCHEMA_PROBE_EVERY_MS - this.now() : 0;
    this.schedule(Math.max(FIRST_DELAY_MS, due));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Lê o contrato agora (uma por vez). */
  check(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), Math.max(0, delay));
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    this.lastAttempt = this.now();
    let error: string | undefined;
    try {
      await this.read();
      this.lastError = undefined;
      log.clearOnce('world-schema-probe');
    } catch (err) {
      error = errMsg(err);
      this.lastError = error;
      log.warnOnce('world-schema-probe', tr('Habblaud World: não foi possível ler o contrato publicado ({0}); o OpenCode fica fora do prédio.', [error]));
    }
    this.schedule(error ? SCHEMA_PROBE_RETRY_MS : SCHEMA_PROBE_EVERY_MS);
    const seen = JSON.stringify(this.get());
    if (seen !== this.lastSeen) {
      this.lastSeen = seen;
      this.opts.onChange?.();
    }
  }

  /** Última visão publicada (para avisar só quando a leitura muda de verdade). */
  private lastSeen = '';
  /** Último erro de leitura: nunca abre o gate, só explica por que não há leitura. */
  private lastError?: string;

  private async read(): Promise<void> {
    const repo = this.opts.repo!;
    const headers: Record<string, string> = { 'User-Agent': 'habblaud-world-schema-probe', Accept: 'application/json' };
    if (this.cache?.etag) headers['If-None-Match'] = this.cache.etag;
    const res = await this.fetchFn(schemaRawUrl(repo), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const now = this.now();
    if (res.status === 304 && this.cache) {
      // Mesmo conteúdo (ETag): é uma leitura confirmada — o gate conta para as duas exigidas.
      const prev = this.cache;
      this.cache = {
        ...prev,
        checkedAt: now,
        observations: prev.observations + 1,
        opencodeObservations: prev.providers?.includes('opencode') ? prev.opencodeObservations + 1 : 0,
      };
      this.save();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.text()).slice(0, 512 * 1024);
    const providers = providerEnumOf(JSON.parse(body));
    const prev = this.cache;
    const had = prev?.providers?.includes('opencode') ?? false;
    this.cache = {
      repo,
      checkedAt: now,
      etag: res.headers.get('etag')?.slice(0, 200) ?? undefined,
      providers,
      observations: (prev?.observations ?? 0) + 1,
      opencodeObservations: providers.includes('opencode') ? (had ? (prev?.opencodeObservations ?? 0) : 0) + 1 : 0,
    };
    this.save();
  }

  private save(): void {
    const file = this.opts.file;
    const c = this.cache;
    if (!file || !c) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(c));
    } catch {
      // Sem disco o gate continua decidindo pela leitura em memória.
    }
  }
}



/** Repositório público do projeto (package.json `repository`), para a URL crua do contrato. */
export function schemaRepo(packageJson: unknown): string | undefined {
  return parseGithubRepo((packageJson as { repository?: unknown } | null)?.repository ?? packageJson);
}
