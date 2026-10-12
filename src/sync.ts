#!/usr/bin/env node
/**
 * SAOS dump -> local mirror (src/store.ts), official bulk API /api/dump/*.
 *
 *   node dist/sync.js            auto: resume the full download until complete, then incremental
 *   node dist/sync.js --full     (re)start the full download from scratch
 *   node dist/sync.js --incremental
 *
 * Full: judgment-date windows (years before 2000, months after) paged with
 * pageSize 100, progress per window in table `windows` - an interrupted run
 * resumes where it stopped. Each finished window is checked against the
 * search API count for the same dates; a short window is downloaded again.
 * Incremental: /dump/judgments?sinceModificationDate=<last sync - 2 days>,
 * every returned judgment is upserted (new and corrected ones alike).
 */

import { fetchJson, SAOS_BASE } from "./http.js";
import { Store, dateRange, type DumpJudgment } from "./store.js";

const PAGE = 100;
const CONCURRENCY = Math.max(1, Number(process.env.SAOS_SYNC_CONCURRENCY ?? 3));
const OVERLAP_MS = 2 * 24 * 3600 * 1000;
const FETCH = { timeoutMs: 180000, attempts: 8 };

interface Page<T> {
  items?: T[];
  links?: Array<{ rel?: string; href?: string }>;
}

const log = (msg: string) => process.stdout.write(`[sync ${new Date().toISOString()}] ${msg}\n`);

function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  return q.toString();
}

async function* pages<T>(path: string, params: Record<string, string | number | undefined>, startPage = 0) {
  for (let p = startPage; ; p++) {
    const data = (await fetchJson(`${SAOS_BASE}${path}?${qs({ ...params, pageSize: PAGE, pageNumber: p })}`, FETCH)) as Page<T>;
    const items = data.items ?? [];
    const hasNext = (data.links ?? []).some((l) => l.rel === "next");
    yield { page: p, items, last: items.length === 0 || !hasNext };
    if (items.length === 0 || !hasNext) return;
  }
}

async function syncDivisions(store: Store): Promise<void> {
  const rows: Array<{ courtType: string; id: number; json: Record<string, unknown> }> = [];
  interface Court { id: number; name: string; code?: string; divisions?: Array<{ id: number; name: string; code?: string }> }
  for await (const { items } of pages<Court>("/dump/commonCourts", {})) {
    for (const c of items) {
      for (const d of c.divisions ?? []) {
        rows.push({ courtType: "COMMON", id: d.id, json: { id: d.id, name: d.name, code: d.code, court: { id: c.id, name: c.name, code: c.code } } });
      }
    }
  }
  interface Chamber { id: number; name: string; divisions?: Array<{ id: number; name: string; fullName?: string }> }
  for await (const { items } of pages<Chamber>("/dump/scChambers", {})) {
    for (const ch of items) {
      for (const d of ch.divisions ?? []) {
        rows.push({ courtType: "SUPREME", id: d.id, json: { id: d.id, name: d.name, chambers: [{ id: ch.id, name: ch.name }] } });
      }
    }
  }
  store.replaceDivisions(rows);
  log(`divisions: ${rows.length}`);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildWindows(): Array<[string, string]> {
  const w: Array<[string, string]> = [["0001-01-01", "1989-12-31"]];
  for (let y = 1990; y < 2000; y++) w.push([`${y}-01-01`, `${y}-12-31`]);
  const now = new Date();
  for (let d = new Date(Date.UTC(2000, 0, 1)); d <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    w.push([iso(d), iso(end)]);
  }
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  w.push([iso(next), "9999-12-31"]);
  return w;
}

async function upstreamCount(from: string, to: string): Promise<number> {
  const data = (await fetchJson(
    `${SAOS_BASE}/search/judgments?${qs({ pageSize: 10, judgmentDateFrom: from, judgmentDateTo: to })}`,
    FETCH
  )) as { info?: { totalResults?: number } };
  return data.info?.totalResults ?? 0;
}

function localCount(store: Store, from: string, to: string): number {
  const [lo, hi] = dateRange(from, to);
  return (store.db.prepare("SELECT count(*) AS n FROM judgments WHERE fts_rowid BETWEEN ? AND ?").get(lo, hi) as { n: number }).n;
}

async function runWindow(store: Store, start: string, end: string, retried = false): Promise<void> {
  const row = store.db.prepare("SELECT next_page, fetched FROM windows WHERE start = ?").get(start) as { next_page: number; fetched: number };
  let fetched = row.fetched;
  const save = store.db.prepare("UPDATE windows SET next_page = ?, fetched = ? WHERE start = ?");
  for await (const { page, items } of pages<DumpJudgment>("/dump/judgments", { judgmentStartDate: start, judgmentEndDate: end }, row.next_page)) {
    if (items.length) store.upsertMany(items);
    fetched += items.length;
    save.run(page + 1, fetched, start);
  }
  const expected = await upstreamCount(start, end);
  const local = localCount(store, start, end);
  if (local < expected && !retried) {
    log(`window ${start}..${end}: local ${local} < upstream ${expected}, downloading again`);
    save.run(0, 0, start);
    return runWindow(store, start, end, true);
  }
  store.db.prepare("UPDATE windows SET expected = ?, completed_at = ? WHERE start = ?").run(expected, new Date().toISOString(), start);
  log(`window ${start}..${end}: ${fetched} fetched, local ${local}, upstream ${expected}${local < expected ? " (SHORT)" : ""}`);
}

async function fullSync(store: Store, restart: boolean): Promise<void> {
  if (restart || !store.getState("full_started_at")) {
    store.db.exec("DELETE FROM windows");
    store.setState("full_started_at", new Date().toISOString());
    store.setState("initial_complete", "0");
  }
  const ins = store.db.prepare("INSERT OR IGNORE INTO windows(start, end) VALUES(?, ?)");
  for (const [s, e] of buildWindows()) ins.run(s, e);

  await syncDivisions(store);

  const todo = store.db.prepare("SELECT start, end FROM windows WHERE completed_at IS NULL ORDER BY start DESC").all() as Array<{ start: string; end: string }>;
  log(`full sync: ${todo.length} windows to go, concurrency ${CONCURRENCY}`);
  let failed = 0;
  const worker = async () => {
    for (let w = todo.shift(); w; w = todo.shift()) {
      try {
        await runWindow(store, w.start, w.end);
      } catch (err) {
        failed++;
        log(`window ${w.start}..${w.end} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed) throw new Error(`${failed} windows failed - rerun to resume`);

  const upstreamTotal = (await fetchJson(`${SAOS_BASE}/search/judgments?pageSize=10`, FETCH)) as { info?: { totalResults?: number } };
  const total = upstreamTotal.info?.totalResults ?? 0;
  const local = store.stats().judgments;
  store.setState("upstream_total", String(total));
  // Changes made upstream while the full download ran are caught by the first
  // incremental run, which starts from the moment the full download began.
  store.setState("last_sync", store.getState("full_started_at") ?? new Date().toISOString());
  store.setState("initial_complete", "1");
  log(`full sync complete: local ${local}, upstream ${total}`);
}

async function incrementalSync(store: Store): Promise<void> {
  const started = new Date().toISOString();
  const last = store.getState("last_sync");
  const since = new Date(new Date(last ?? started).getTime() - OVERLAP_MS).toISOString().replace("Z", "");
  await syncDivisions(store);
  let n = 0;
  for await (const { items } of pages<DumpJudgment>("/dump/judgments", { sinceModificationDate: since })) {
    if (items.length) store.upsertMany(items);
    n += items.length;
  }
  store.setState("last_sync", started);
  log(`incremental since ${since}: ${n} judgments upserted, local total ${store.stats().judgments}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const store = new Store();
  const started = new Date().toISOString();
  try {
    if (args.has("--full")) await fullSync(store, true);
    else if (args.has("--incremental") || store.isReady()) await incrementalSync(store);
    else await fullSync(store, false);
    store.setState("last_sync_result", `ok ${started} -> ${new Date().toISOString()}`);
    if (!store.isReady()) process.exitCode = 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setState("last_sync_result", `error ${started}: ${msg}`);
    log(`ERROR: ${msg}`);
    process.exitCode = 1;
  }
}

main();
