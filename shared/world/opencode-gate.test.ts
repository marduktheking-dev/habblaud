// O gate do OpenCode (shared/world/opencode-gate.ts) é a única porta entre o escritório local e o `provider` do pacote
// do prédio. Aqui está cada barreira isolada: flag, leitura fresca do contrato remoto, duas observações do valor,
// enum remoto com "opencode" e o corte depois de uma recusa do servidor — e a garantia de que qualquer uma fechada
// devolve o conjunto publicado (claude|codex), nunca mais do que o contrato remoto aceita.
import { describe, expect, it } from 'vitest';
import {
  ackCutsGate,
  cutFromAck,
  HABBLAUD_PROVIDERS,
  openCodeGate,
  openCodeGateView,
  OPENCODE_ACK_COOLDOWN_MS,
  OPENCODE_MIN_OBSERVATIONS,
  OPENCODE_PROBE_MAX_AGE_MS,
  WORLD_PUBLISHED_PROVIDERS,
  type OpenCodeGateState,
  type OpenCodeProbe,
} from './opencode-gate';

const NOW = 1_760_000_000_000;

/** Sonda que já leu duas vezes um contrato com opencode, bem fresca. */
function fresh(providers: string[] = ['claude', 'codex', 'opencode'], over: Partial<OpenCodeProbe> = {}): OpenCodeProbe {
  const yes = providers.includes('opencode');
  return {
    checkedAt: NOW - 60_000,
    observations: 3,
    opencodeObservations: yes ? OPENCODE_MIN_OBSERVATIONS : 0,
    providers,
    ...over,
  };
}

const state = (over: Partial<OpenCodeGateState> = {}): OpenCodeGateState => ({ flag: true, probe: fresh(), now: NOW, ...over });

describe('gate do OpenCode: barreira por barreira', () => {
  it('tudo aberto: o pacote pode conter os três providers e devolve o conjunto do contrato remoto', () => {
    const r = openCodeGate(state());
    expect(r).toMatchObject({ allowed: true, reason: 'open', providers: ['claude', 'codex', 'opencode'], checkedAt: NOW - 60_000 });
    expect(new Set(r.providers)).toEqual(new Set(HABBLAUD_PROVIDERS));
  });

  it('flag desligada fecha mesmo com o contrato remoto aceitando (humano diz não)', () => {
    expect(openCodeGate(state({ flag: false }))).toMatchObject({ allowed: false, reason: 'flag_off' });
  });

  it('sem leitura nenhuma = fechado (fail-safe: o padrão é o publicado)', () => {
    expect(openCodeGate({ flag: true, now: NOW })).toMatchObject({ allowed: false, reason: 'unknown_remote', providers: WORLD_PUBLISHED_PROVIDERS });
    expect(openCodeGate(state({ probe: { providers: ['claude', 'codex', 'opencode'] } }))).toMatchObject({ allowed: false, reason: 'unknown_remote' });
  });

  it('leitura vencida não decide (a sonda corre a cada 6 h; a folga é 7 h)', () => {
    const stale = fresh(['claude', 'codex', 'opencode'], { checkedAt: NOW - OPENCODE_PROBE_MAX_AGE_MS - 1 });
    expect(openCodeGate(state({ probe: stale }))).toMatchObject({ allowed: false, reason: 'unknown_remote' });
    const justInTime = fresh(['claude', 'codex', 'opencode'], { checkedAt: NOW - OPENCODE_PROBE_MAX_AGE_MS });
    expect(openCodeGate(state({ probe: justInTime })).reason).toBe('open');
  });

  it('uma leitura isolada não basta: exige duas observações do valor', () => {
    const one = fresh(['claude', 'codex', 'opencode'], { opencodeObservations: 1 });
    expect(openCodeGate(state({ probe: one }))).toMatchObject({ allowed: false, reason: 'unknown_remote' });
    const freshButNoOpencodeYet = fresh(['claude', 'codex'], { observations: 9 });
    expect(openCodeGate(state({ probe: { ...freshButNoOpencodeYet, providers: ['claude', 'codex'] } })).reason).toBe('remote_denied');
    const many = fresh(['claude', 'codex', 'opencode'], { opencodeObservations: 9 });
    expect(openCodeGate(state({ probe: many })).allowed).toBe(true);
  });

  it('contrato remoto ainda sem opencode: mantém o publicado, sem mentir nem subir errado', () => {
    const r = openCodeGate(state({ probe: fresh(['claude', 'codex']) }));
    expect(r).toMatchObject({ allowed: false, reason: 'remote_denied', providers: WORLD_PUBLISHED_PROVIDERS });
    expect(r.providers).not.toContain('opencode');
  });

  it('contrato remoto sem codex (mudança do mundo): só o que ele aceita', () => {
    const r = openCodeGate(state({ probe: fresh(['claude', 'opencode']) }));
    expect(r.allowed).toBe(true);
    expect(r.providers).toEqual(['claude', 'opencode']);
  });

  it('recusa do servidor (ack schema/implausible) fecha por 6 h; uma recusa antiga não prende', () => {
    const cut = { at: NOW - 60_000, error: 'schema' as const };
    expect(openCodeGate(state({ cut }))).toMatchObject({ allowed: false, reason: 'ack_cut' });
    expect(openCodeGate(state({ cut: { ...cut, error: 'implausible' as const } })).reason).toBe('ack_cut');
    const old = { at: NOW - OPENCODE_ACK_COOLDOWN_MS - 1, error: 'schema' as const };
    expect(openCodeGate(state({ cut: old }))).toMatchObject({ allowed: true, reason: 'open' });
  });

  it('qualquer barreira fechada devolve no máximo o conjunto publicado', () => {
    const closed = [
      openCodeGate(state({ flag: false })),
      openCodeGate({ flag: true, now: NOW }),
      openCodeGate(state({ probe: fresh(['claude', 'codex']) })),
      openCodeGate(state({ cut: { at: NOW, error: 'schema' as const } })),
    ];
    for (const r of closed) {
      expect(r.allowed).toBe(false);
      expect(r.providers.every((p) => (WORLD_PUBLISHED_PROVIDERS as readonly string[]).includes(p))).toBe(true);
    }
  });
});

describe('gate do OpenCode: recusa do servidor vira corte', () => {
  it('só schema e implausible cortam; os demais erros não têm a ver com o formato do pacote', () => {
    expect(ackCutsGate('schema')).toBe(true);
    expect(ackCutsGate('implausible')).toBe(true);
    for (const e of ['limits', 'name_pool', 'parts', 'ids', 'rate', 'internal', 'left'] as const) expect(ackCutsGate(e)).toBe(false);
    expect(ackCutsGate(undefined)).toBe(false);
  });

  it('o corte vem do ack do último pacote: ok limpa, e ack ausente não corta nada', () => {
    expect(cutFromAck(undefined)).toBeUndefined();
    expect(cutFromAck({ ok: true })).toBeUndefined();
    expect(cutFromAck({ ok: false, error: 'rate', at: NOW })).toBeUndefined();
    expect(cutFromAck({ ok: false, error: 'schema', at: NOW })).toEqual({ at: NOW, error: 'schema' });
    expect(cutFromAck({ ok: false, error: 'implausible' })).toEqual({ at: 0, error: 'implausible' });
  });

  it('a visão para /api/world/status leva flag, motivo, leitura e o corte que está prendendo', () => {
    const probe = { ...fresh(), error: 'HTTP 502' };
    const st = state({ probe, cut: { at: NOW - 1_000, error: 'schema' as const } });
    const view = openCodeGateView(openCodeGate(st), st);
    expect(view).toMatchObject({
      flag: true,
      allowed: false,
      reason: 'ack_cut',
      providers: WORLD_PUBLISHED_PROVIDERS,
      checkedAt: NOW - 60_000,
      probeError: 'HTTP 502',
      cut: { at: NOW - 1_000, error: 'schema' },
    });
  });
});
