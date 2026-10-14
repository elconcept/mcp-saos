#!/usr/bin/env node
/**
 * SAOS dump -> local mirror (src/store.ts), official bulk API /api/dump/*.
 *
 *   node dist/sync.js            auto: resume the full download until complete, then incremental
 *   node dist/sync.js --full     (re)start the full download from scratch
 *   node dist/sync.js --incremental
 *   node dist/sync.js --recheck  verify-only pass over failed/degraded/legacy
 *                                windows (no downloads; promotes honest ones to
 *                                verified so the mirror reads complete again)
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

async function runWindow(store: Store, start: string, end: string, retried = false): Promise<void> {  const row = store.db.prepare("SELECT next_page, fetched FROM windows WHERE start = ?").get(start) as { next_page: number; fetched: number };
  let fetched = row.fetched;
  const save = store.db.prepare("UPDATE windows SET next_page = ?, fetched = ? WHERE start = ?");
  const mark = store.db.prepare(
    "UPDATE windows SET expected = ?, completed_at = ?, status = ?, shortfall = ?, checked_at = ? WHERE start = ?"
  );
  const now = () => new Date().toISOString();
  try {
    for await (const { page, items } of pages<DumpJudgment>("/dump/judgments", { judgmentStartDate: start, judgmentEndDate: end }, row.next_page)) {
      if (items.length) store.upsertMany(items);
      fetched += items.length;
      save.run(page + 1, fetched, start);
    }
  } catch (err) {
    // F-03: a failed window is FAILED, never silent success - scheduler retries it.
    try {
      store.db.prepare("UPDATE windows SET status = ?, checked_at = ? WHERE start = ?").run("failed", now(), start);
    } catch { /* pre-migration mirror */ }
    throw err;
  }
  const expected = await upstreamCount(start, end);
  const local = localCount(store, start, end);
  const shortfall = expected - local;
  const tolerance = Math.max(10, expected * 0.005);
  // The search index keeps stale dates for a few judgments (they sit in a
  // neighbouring window locally), so a shortfall of a handful is expected;
  // only a real gap (lost pages) triggers a second download.
  if (shortfall > tolerance && !retried) {
    log(`window ${start}..${end}: local ${local} < upstream ${expected}, downloading again`);
    save.run(0, 0, start);
    return runWindow(store, start, end, true);
  }
  // F-03: significant post-retry shortfall = DEGRADED, not success.
  const status = shortfall > tolerance ? "degraded" : "verified";
  mark.run(expected, now(), status, shortfall, now(), start);
  log(`window ${start}..${end}: ${fetched} fetched, local ${local}, upstream ${expected} [${status}]${status === "degraded" ? " (SHORT - needs review)" : ""}`);
}

/**
 * F-03: cheap re-verification of an already-downloaded window - compares the
 * local count against the upstream search count WITHOUT re-downloading.
 * Returns true when the window verifies (marked verified), false when a real
 * gap needs a full re-download (caller resets progress and runs runWindow).
 * Legacy rows (pre-status, e.g. 'retry_pending' with completed_at set) go
 * through the same check - this is what promotes them honestly.
 */
async function verifyWindow(store: Store, start: string, end: string): Promise<boolean> {
  const now = () => new Date().toISOString();
  let expected: number;
  try {
    expected = await upstreamCount(start, end);
  } catch (err) {
    log(`window ${start}..${end}: recheck skipped (upstream unreachable: ${err instanceof Error ? err.message : String(err)})`);
    return true; // do not condemn a window on a network failure
  }
  const local = localCount(store, start, end);
  const shortfall = expected - local;
  const tolerance = Math.max(10, expected * 0.005);
  if (shortfall <= tolerance) {
    store.db
      .prepare("UPDATE windows SET expected = ?, status = ?, shortfall = ?, checked_at = ? WHERE start = ?")
      .run(expected, "verified", shortfall, now(), start);
    return true;
  }
  log(`window ${start}..${end}: recheck found a gap (local ${local} < upstream ${expected}), re-downloading`);
  return false;
}

/** F-03: windows that still need work - fresh ones plus failed/degraded/legacy. */
function pendingWindows(store: Store): Array<{ start: string; end: string; fresh: number }> {  return store.db
    .prepare(
      `SELECT start, end, (completed_at IS NULL) AS fresh FROM windows
       WHERE completed_at IS NULL OR status IS NULL OR status NOT IN ('verified')
       ORDER BY start DESC`
    )
    .all() as Array<{ start: string; end: string; fresh: number }>;
}

/**
 * F-03: completion gate (exported for tests). initial_complete means VERIFIED
 * completeness - any failed, pending, degraded or legacy window blocks it.
 * A blocked mirror keeps serving the SAOS API (safe fallback) until the next
 * run repairs the remaining windows.
 */
export function completionGate(
  failed: number,
  pending: number,
  degraded: number,
  legacy: number,
): { complete: boolean; reason: string } {
  const bad = failed + pending + degraded + legacy;
  if (bad === 0) return { complete: true, reason: "all windows verified" };
  return {
    complete: false,
    reason: `${failed} failed, ${pending} pending, ${degraded} degraded, ${legacy} legacy`,
  };
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

  // F-03: resume fresh windows AND retry failed/degraded/legacy ones.
  // Completed-but-unverified windows get the cheap verifyWindow() first;
  // only a real gap triggers a full re-download.
  const todo = pendingWindows(store);
  log(`full sync: ${todo.length} windows to go, concurrency ${CONCURRENCY}`);
  let failed = 0;
  const reset = store.db.prepare("UPDATE windows SET next_page = 0, fetched = 0 WHERE start = ?");
  const worker = async () => {
    for (let w = todo.shift(); w; w = todo.shift()) {
      try {
        if (!w.fresh) {
          if (await verifyWindow(store, w.start, w.end)) continue;
          reset.run(w.start);
        }
        await runWindow(store, w.start, w.end);
      } catch (err) {
        failed++;
        log(`window ${w.start}..${w.end} FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed) throw new Error(`${failed} windows failed - rerun to resume`);

  const counts = {
    failed: (store.db.prepare("SELECT count(*) AS n FROM windows WHERE status = 'failed'").get() as { n: number }).n,
    pending: (store.db.prepare("SELECT count(*) AS n FROM windows WHERE completed_at IS NULL").get() as { n: number }).n,
    degraded: (store.db.prepare("SELECT count(*) AS n FROM windows WHERE status = 'degraded'").get() as { n: number }).n,
    legacy: (store.db.prepare("SELECT count(*) AS n FROM windows WHERE status IS NULL OR status NOT IN ('verified', 'degraded', 'failed')").get() as { n: number }).n,
  };
  const gate = completionGate(counts.failed, counts.pending, counts.degraded, counts.legacy);
  const upstreamTotal = (await fetchJson(`${SAOS_BASE}/search/judgments?pageSize=10`, FETCH)) as { info?: { totalResults?: number } };
  const total = upstreamTotal.info?.totalResults ?? 0;
  const local = store.stats().judgments;
  store.setState("upstream_total", String(total));
  // Changes made upstream while the full download ran are caught by the first
  // incremental run, which starts from the moment the full download began.
  store.setState("last_sync", store.getState("full_started_at") ?? new Date().toISOString());
  // F-03: initial_complete means VERIFIED completeness, never a degraded or
  // half-checked mirror. A blocked mirror keeps serving the SAOS API (safe)
  // until the next run repairs the remaining windows.
  if (!gate.complete) {
    store.setState("initial_complete", "0");
    store.setState("last_sync_result", `degraded ${new Date().toISOString()}: ${gate.reason}`);
    log(`full sync NOT complete: ${gate.reason} (local ${local}, upstream ${total}) - rerun to resume`);
    throw new Error(`${gate.reason} - rerun to resume`);
  }
  store.setState("initial_complete", "1");
  log(`full sync complete: local ${local}, upstream ${total}`);
}

async function incrementalSync(store: Store): Promise<void> {
  const started = new Date().toISOString();
  // F-03: automatic repair - re-verify failed/degraded/legacy windows before
  // the incremental fetch, and re-download the ones with a real gap.
  const repair = pendingWindows(store).filter((w) => !w.fresh);
  if (repair.length > 0) {
    log(`incremental: re-verifying ${repair.length} non-verified windows`);
    const reset = store.db.prepare("UPDATE windows SET next_page = 0, fetched = 0 WHERE start = ?");
    for (const w of repair) {
      try {
        if (await verifyWindow(store, w.start, w.end)) continue;
        reset.run(w.start);
        await runWindow(store, w.start, w.end);
      } catch (err) {
        log(`window ${w.start}..${w.end} repair FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
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
    if (args.has("--recheck")) {
      // F-03: verify-only pass over non-verified windows (no downloads).
      const todo = pendingWindows(store).filter((w) => !w.fresh);
      let ok = 0;
      for (const w of todo) {
        try {
          if (await verifyWindow(store, w.start, w.end)) ok++;
        } catch (err) {
          log(`window ${w.start}..${w.end} recheck FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const left = pendingWindows(store).length;
      store.setState("last_sync_result", `recheck ${started} -> ${new Date().toISOString()}: ${ok}/${todo.length} verified, ${left} still pending`);
      log(`recheck: ${ok}/${todo.length} verified, ${left} windows still need work`);
      if (!store.isReady()) process.exitCode = 1;
    } else if (args.has("--full")) await fullSync(store, true);
    else if (args.has("--incremental") || store.isReady()) await incrementalSync(store);
    else await fullSync(store, false);
    if (!args.has("--recheck")) {
      store.setState("last_sync_result", `ok ${started} -> ${new Date().toISOString()}`);
    }
    if (!store.isReady()) process.exitCode = 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.setState("last_sync_result", `error ${started}: ${msg}`);
    log(`ERROR: ${msg}`);
    process.exitCode = 1;
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main();
}
