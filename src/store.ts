/**
 * Local mirror of the SAOS dump (SQLite via node:sqlite, FTS5 full text).
 *
 * judgments: raw dump JSON (deflate) per judgment id - returned verbatim.
 * fts:       searchable columns. rowid = YYYYMMDD * 1e7 + id, so "ORDER BY rowid
 *            DESC" is the SAOS sort (JUDGMENT_DATE DESC) and date ranges are
 *            rowid ranges - both cheap inside FTS5, no join needed to page.
 * divisions: court / division names from /dump/commonCourts and /dump/scChambers
 *            (dump items carry only division.id).
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { stripHtml } from "./text.js";

export interface DumpJudgment {
  id: number;
  courtType?: string;
  courtCases?: Array<{ caseNumber?: string }>;
  judgmentType?: string;
  judgmentDate?: string;
  judges?: Array<{ name?: string }>;
  keywords?: string[];
  textContent?: string;
  legalBases?: unknown[];
  referencedRegulations?: Array<{ text?: string }>;
  division?: { id?: number } & Record<string, unknown>;
  [k: string]: unknown;
}

const ID_SPAN = 10_000_000;

export function dateKey(date: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  return m ? Number(m[1] + m[2] + m[3]) : 0;
}

/**
 * Strict ISO calendar-date check (F-07). dateKey() returns 0 for garbage,
 * which silently disabled the date filter - callers must validate FIRST and
 * return `invalid_date` (fault=caller) instead of querying.
 */
export function isValidIsoDate(s: string | undefined): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1000 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** F-04: one-way hash for diagnostics - raw queries never leave the process. */
export function hashParams(params: unknown): string {
  return createHash("sha256").update(JSON.stringify(params) ?? "", "utf-8").digest("hex").slice(0, 16);
}

export function ftsRowid(id: number, date: string | undefined): number {
  return dateKey(date) * ID_SPAN + id;
}

export function dateRange(from?: string, to?: string): [number, number] {
  const lo = from ? dateKey(from) : 0;
  const hi = to ? dateKey(to) : 99_999_999;
  return [lo * ID_SPAN, hi * ID_SPAN + ID_SPAN - 1];
}

export function defaultDbPath(): string {
  return process.env.SAOS_DB ?? "/data/saos.sqlite";
}

function legalText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).map(legalText).filter(Boolean).join(" ");
  }
  return v === null || v === undefined ? "" : String(v);
}

export class Store {
  readonly db: DatabaseSync;
  private st: Record<string, StatementSync> = {};
  private divCache = new Map<string, Record<string, unknown> | null>();

  constructor(path = defaultDbPath(), readOnly = false) {
    if (!readOnly) mkdirSync(dirname(path), { recursive: true });
    // Loaded lazily: node:sqlite needs Node >= 22.13; on older Node the server
    // still works against the SAOS API (engine.ts falls back when this throws).
    const { DatabaseSync: Db } = require("node:sqlite") as typeof import("node:sqlite");
    this.db = new Db(path, { readOnly });
    this.db.exec("PRAGMA busy_timeout = 30000");
    if (!readOnly) {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS judgments (
          id INTEGER PRIMARY KEY,
          fts_rowid INTEGER NOT NULL,
          court_type TEXT,
          judgment_date TEXT,
          data BLOB NOT NULL,
          synced_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS judgments_fts_rowid ON judgments(fts_rowid);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
          ct, cn, judges, legal, regs, kw, body,
          tokenize = "unicode61 remove_diacritics 2"
        );
        CREATE TABLE IF NOT EXISTS divisions (
          court_type TEXT NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY (court_type, id)
        );
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS windows (
          start TEXT PRIMARY KEY, end TEXT NOT NULL, next_page INTEGER NOT NULL DEFAULT 0,
          fetched INTEGER NOT NULL DEFAULT 0, expected INTEGER, completed_at TEXT,
          status TEXT NOT NULL DEFAULT 'retry_pending', shortfall INTEGER, checked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS discrepancies (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tool TEXT NOT NULL,
          params TEXT NOT NULL, upstream_total INTEGER, upstream_ids TEXT
        );
      `);
      // Migrate pre-1.4.0 mirrors (F-03): new window-status columns.
      for (const col of [
        "ALTER TABLE windows ADD COLUMN status TEXT NOT NULL DEFAULT 'retry_pending'",
        "ALTER TABLE windows ADD COLUMN shortfall INTEGER",
        "ALTER TABLE windows ADD COLUMN checked_at TEXT",
      ]) {
        try {
          this.db.exec(col);
        } catch {
          /* column already exists */
        }
      }
    }
  }

  private stmt(sql: string): StatementSync {
    return (this.st[sql] ??= this.db.prepare(sql));
  }

  close(): void {
    this.st = {};
    this.divCache.clear();
    this.db.close();
  }

  // --- state ---------------------------------------------------------------

  getState(key: string): string | null {
    const r = this.stmt("SELECT value FROM state WHERE key = ?").get(key) as { value?: string } | undefined;
    return r?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.stmt("INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  isReady(): boolean {
    return this.getState("initial_complete") === "1";
  }

  // --- writes --------------------------------------------------------------

  upsertMany(items: DumpJudgment[]): void {
    const now = new Date().toISOString();
    const getOld = this.stmt("SELECT fts_rowid FROM judgments WHERE id = ?");
    const delFts = this.stmt("DELETE FROM fts WHERE rowid = ?");
    const insFts = this.stmt(
      "INSERT INTO fts(rowid, ct, cn, judges, legal, regs, kw, body) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const upJ = this.stmt(
      `INSERT INTO judgments(id, fts_rowid, court_type, judgment_date, data, synced_at) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET fts_rowid = excluded.fts_rowid, court_type = excluded.court_type,
         judgment_date = excluded.judgment_date, data = excluded.data, synced_at = excluded.synced_at`
    );
    this.db.exec("BEGIN");
    try {
      for (const it of items) {
        if (typeof it.id !== "number") continue;
        const rowid = ftsRowid(it.id, it.judgmentDate);
        const old = getOld.get(it.id) as { fts_rowid?: number } | undefined;
        if (old?.fts_rowid !== undefined) delFts.run(old.fts_rowid);
        insFts.run(
          rowid,
          `ct_${(it.courtType ?? "unknown").toLowerCase()}`,
          (it.courtCases ?? []).map((c) => c.caseNumber ?? "").join(" ; "),
          (it.judges ?? []).map((j) => j.name ?? "").join(" ; "),
          (it.legalBases ?? []).map(legalText).join(" ; "),
          (it.referencedRegulations ?? []).map((r) => r.text ?? "").join(" ; "),
          (it.keywords ?? []).join(" ; "),
          stripHtml(it.textContent ?? "")
        );
        upJ.run(it.id, rowid, it.courtType ?? null, it.judgmentDate ?? null,
          deflateSync(Buffer.from(JSON.stringify(it), "utf-8")), now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  replaceDivisions(rows: Array<{ courtType: string; id: number; json: Record<string, unknown> }>): void {
    const ins = this.stmt("INSERT OR REPLACE INTO divisions(court_type, id, json) VALUES(?, ?, ?)");
    this.db.exec("BEGIN");
    for (const r of rows) ins.run(r.courtType, r.id, JSON.stringify(r.json));
    this.db.exec("COMMIT");
  }

  logDiscrepancy(tool: string, params: unknown, upstreamTotal: number, upstreamIds: number[]): void {
    this.stmt(
      "INSERT INTO discrepancies(at, tool, params, upstream_total, upstream_ids) VALUES(?, ?, ?, ?, ?)"
    ).run(new Date().toISOString(), tool, JSON.stringify(params), upstreamTotal, upstreamIds.join(","));
  }

  // --- reads ---------------------------------------------------------------

  /** Division object shaped like the SAOS REST API (court / chamber names). */
  division(courtType: string | undefined, id: number | undefined): Record<string, unknown> | null {
    if ((courtType !== "COMMON" && courtType !== "SUPREME") || id === undefined) return null;
    const key = `${courtType}:${id}`;
    if (!this.divCache.has(key)) {
      const r = this.stmt("SELECT json FROM divisions WHERE court_type = ? AND id = ?").get(
        courtType, id
      ) as { json?: string } | undefined;
      this.divCache.set(key, r?.json ? (JSON.parse(r.json) as Record<string, unknown>) : null);
    }
    return this.divCache.get(key) ?? null;
  }

  getJudgment(id: number): DumpJudgment | null {
    const r = this.stmt("SELECT data FROM judgments WHERE id = ?").get(id) as { data?: Uint8Array } | undefined;
    if (!r?.data) return null;
    const j = JSON.parse(inflateSync(r.data).toString("utf-8")) as DumpJudgment;
    const div = this.division(j.courtType, j.division?.id);
    if (div) j.division = { ...j.division, ...div };
    return j;
  }

  /** FTS search ordered by judgment date DESC. Returns ids + snippets for the page and the total. */
  searchFts(match: string, range: [number, number], limit: number, offset: number, withSnippet: boolean) {
    const total = (this.stmt(
      "SELECT count(*) AS n FROM fts WHERE fts MATCH ? AND rowid BETWEEN ? AND ?"
    ).get(match, range[0], range[1]) as { n: number }).n;
    const rows = this.stmt(
      `SELECT rowid, ${withSnippet ? "snippet(fts, 6, '<em>', '</em>', ' ... ', 48)" : "substr(body, 1, 400)"} AS snip
       FROM fts WHERE fts MATCH ? AND rowid BETWEEN ? AND ? ORDER BY rowid DESC LIMIT ? OFFSET ?`
    ).all(match, range[0], range[1], limit, offset) as Array<{ rowid: number; snip: string }>;
    return { total, rows: rows.map((r) => ({ id: r.rowid % ID_SPAN, snippet: r.snip })) };
  }

  /** No text criteria: plain date-ordered listing. */
  searchAll(range: [number, number], limit: number, offset: number) {
    const total = (this.stmt(
      "SELECT count(*) AS n FROM judgments WHERE fts_rowid BETWEEN ? AND ?"
    ).get(range[0], range[1]) as { n: number }).n;
    const rows = this.stmt(
      `SELECT j.id AS id, substr(f.body, 1, 400) AS snip FROM judgments j JOIN fts f ON f.rowid = j.fts_rowid
       WHERE j.fts_rowid BETWEEN ? AND ? ORDER BY j.fts_rowid DESC LIMIT ? OFFSET ?`
    ).all(range[0], range[1], limit, offset) as Array<{ id: number; snip: string }>;
    return { total, rows: rows.map((r) => ({ id: r.id, snippet: r.snip })) };
  }

  stats() {
    const one = (sql: string) => (this.stmt(sql).get() as { n: number | null }).n;
    const winStatus = (s: string) => {
      try {
        return one(`SELECT count(*) AS n FROM windows WHERE status = '${s}'`);
      } catch {
        return null;
      }
    };
    // F-04: public diagnostics NEVER carry raw query params or upstream ids
    // (PII / query-content leak via GET /status). Only hashes + counts.
    let recent: Array<Record<string, unknown>> = [];
    try {
      const rows = this.stmt(
        "SELECT at, tool, params, upstream_total, upstream_ids FROM discrepancies ORDER BY id DESC LIMIT 20"
      ).all() as Array<{ at: string; tool: string; params: string; upstream_total: number; upstream_ids: string }>;
      recent = rows.map((r) => ({
        at: r.at,
        tool: r.tool,
        params_hash: hashParams(r.params),
        upstream_total: r.upstream_total,
        upstream_ids_count: r.upstream_ids ? r.upstream_ids.split(",").filter(Boolean).length : 0,
      }));
    } catch {
      recent = [];
    }
    return {
      judgments: one("SELECT count(*) AS n FROM judgments"),
      divisions: one("SELECT count(*) AS n FROM divisions"),
      windows_total: one("SELECT count(*) AS n FROM windows"),
      windows_done: one("SELECT count(*) AS n FROM windows WHERE completed_at IS NOT NULL"),
      windows_verified: winStatus("verified"),
      windows_degraded: winStatus("degraded"),
      windows_failed: winStatus("failed"),
      discrepancies: one("SELECT count(*) AS n FROM discrepancies"),
      initial_complete: this.isReady(),
      last_sync: this.getState("last_sync"),
      last_sync_result: this.getState("last_sync_result"),
      upstream_total_at_full_sync: this.getState("upstream_total"),
      index_status: this.mirrorIntegrity().status,
      recent_discrepancies: recent,
    };
  }

  /**
   * F-02: mirror completeness audit - distinguishes complete / partial /
   * stale / unverified WITHOUT querying the API per request (sampling is
   * done by sync + discrepancy logging, this only aggregates).
   */
  mirrorIntegrity(): {
    status: "complete" | "partial" | "stale" | "unverified";
    detail: string;
  } {
    if (!this.isReady()) return { status: "unverified", detail: "initial sync not complete" };
    const one = (sql: string) => {
      try {
        return (this.stmt(sql).get() as { n: number | null }).n ?? 0;
      } catch {
        return 0;
      }
    };
    const total = one("SELECT count(*) AS n FROM windows");
    const degraded = one("SELECT count(*) AS n FROM windows WHERE status = 'degraded'");
    const failed = one("SELECT count(*) AS n FROM windows WHERE status = 'failed'");
    const pending = one("SELECT count(*) AS n FROM windows WHERE completed_at IS NULL");
    if (failed > 0 || pending > 0)
      return { status: "partial", detail: `${failed} failed, ${pending} pending of ${total} windows` };
    if (degraded > 0)
      return { status: "partial", detail: `${degraded} degraded of ${total} windows` };
    const last = Date.parse(this.getState("last_sync") ?? "") || 0;
    if (Date.now() - last > 72 * 3600 * 1000)
      return { status: "stale", detail: "last sync over 72h ago" };
    if (total === 0) return { status: "unverified", detail: "no window data" };
    return { status: "complete", detail: `${total} windows verified` };
  }
}
