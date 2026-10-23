/**
 * Pamiec "biezacej tury" dla show_sources (efekt jak Show_Sources w IURA).
 *
 * Serwer jest bezstanowy na poziomie MCP (nowa instancja na zadanie HTTP), wiec
 * wyniki wyszukiwan zapamietujemy w procesie, pod kluczem rozmowcy (callerKey).
 * Co przechowujemy: WYLACZNIE publiczne metadane orzeczen (citations z SAOS), bez
 * tresci zapytan, w RAM, z TTL; nic nie jest zapisywane na dysk ani logowane.
 * show_sources bez parametrow wyswietla zapamietane orzeczenia i czysci pamiec
 * (nastepna tura zaczyna od zera).
 *
 * Klucz rozmowcy (callerKeyFromHeaders): naglowek mcp-session-id, w przeciwnym
 * razie tozsamosc z Cloudflare Access / Authorization (haszowana). Gdy brak
 * jakiejkolwiek tozsamosci, pamiec jest WYLACZONA (inaczej wyniki mogly by
 * przeciekac miedzy uzytkownikami wspoldzielacymi proxy) - chyba ze
 * SAOS_STATE_SHARED=1 (instalacja jednoosobowa).
 */

import { createHash } from "node:crypto";

export const TURN_TTL_MS_DEFAULT = 15 * 60 * 1000;
export const TURN_MAX_ITEMS = 100;
export const TURN_MAX_KEYS = 500;

interface Entry<T> {
  touched: number;
  items: Map<number, T>;
}

export class TurnState<T extends { saos_id?: number }> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number = TURN_TTL_MS_DEFAULT,
    private readonly now: () => number = Date.now
  ) {}

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.map) if (t - e.touched > this.ttlMs) this.map.delete(k);
    while (this.map.size > TURN_MAX_KEYS) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Dopisuje orzeczenia (dedupe po saos_id; ponowne trafienie przesuwa na koniec). */
  record(key: string | null, items: readonly T[]): void {
    if (!key || items.length === 0) return;
    this.prune();
    const e = this.map.get(key) ?? { touched: this.now(), items: new Map<number, T>() };
    for (const it of items) {
      if (typeof it.saos_id !== "number") continue;
      e.items.delete(it.saos_id);
      e.items.set(it.saos_id, it);
    }
    while (e.items.size > TURN_MAX_ITEMS) {
      const first = e.items.keys().next().value;
      if (first === undefined) break;
      e.items.delete(first);
    }
    e.touched = this.now();
    this.map.delete(key);
    this.map.set(key, e);
  }

  peek(key: string | null): T[] {
    if (!key) return [];
    this.prune();
    return [...(this.map.get(key)?.items.values() ?? [])];
  }

  get(key: string | null, id: number): T | undefined {
    if (!key) return undefined;
    this.prune();
    return this.map.get(key)?.items.get(id);
  }

  clear(key: string | null): void {
    if (key) this.map.delete(key);
  }

  size(): number {
    this.prune();
    return this.map.size;
  }
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);

type HeaderBag = Record<string, string | string[] | undefined>;

function first(h: HeaderBag, name: string): string | undefined {
  const v = h[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

/** Klucz rozmowcy z naglowkow HTTP albo null (pamiec wylaczona). */
export function callerKeyFromHeaders(h: HeaderBag, env: NodeJS.ProcessEnv = process.env): string | null {
  const session = first(h, "mcp-session-id");
  if (session) return "s:" + sha(session);
  const email = first(h, "cf-access-authenticated-user-email");
  if (email) return "u:" + sha(email.toLowerCase());
  const jwt = first(h, "cf-access-jwt-assertion") ?? first(h, "authorization");
  if (jwt) return "t:" + sha(jwt);
  return env.SAOS_STATE_SHARED === "1" ? "shared" : null;
}

export function turnTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SAOS_STATE_TTL_S);
  return Number.isFinite(n) && n > 0 ? n * 1000 : TURN_TTL_MS_DEFAULT;
}
