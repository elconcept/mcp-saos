/**
 * Search engine: local dump first (src/store.ts), SAOS REST API as a fallback.
 *
 * - No local mirror (file missing) or the first full download not finished yet
 *   -> SAOS API, exactly as before (source "saos_api").
 * - Mirror ready -> local answer (source "local_dump"). When the local answer is
 *   empty, the SAOS API is asked as a cross-check; a non-empty upstream answer
 *   means the mirror is missing something: it is returned (source
 *   "saos_api_fallback") and logged in the `discrepancies` table + stderr.
 *
 * Responses keep the SAOS API shapes (SearchResponse / judgment object), so the
 * formatters and the citator work unchanged on both sources.
 */

import { existsSync } from "node:fs";
import { fetchJson, SAOS_BASE } from "./http.js";
import { Store, dateRange, defaultDbPath, hashParams, type DumpJudgment } from "./store.js";
import { buildAllTokens, buildPhrase, buildTextQuery } from "./text.js";

// Minimum pageSize enforced by the SAOS API. Smaller values return HTTP 400.
export const PAGE_SIZE_MIN = 10;
export const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 100;

export interface SearchParams {
  all?: string;
  caseNumber?: string;
  courtType?: string;
  judgeName?: string;
  referencedRegulation?: string;
  legalBase?: string;
  judgmentDateFrom?: string;
  judgmentDateTo?: string;
  pageSize?: number;
  pageNumber?: number;
}

export type Source = "local_dump" | "saos_api" | "saos_api_fallback";

export interface EngineResult {
  data: unknown;
  source: Source;
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Upstream (SAOS REST API)
// ---------------------------------------------------------------------------

export async function saosSearch(params: SearchParams): Promise<unknown> {
  // Enforce minimum pageSize
  const size = Math.max(
    PAGE_SIZE_MIN,
    typeof params.pageSize === "number" ? params.pageSize : PAGE_SIZE_DEFAULT
  );

  const query: Record<string, string> = {
    pageSize: String(size),
    pageNumber: String(params.pageNumber ?? 0),
    sortingField: "JUDGMENT_DATE",
    sortingDirection: "DESC",
  };

  if (params.all) query.all = params.all;
  if (params.caseNumber) query.caseNumber = params.caseNumber;
  if (params.courtType) query.courtType = params.courtType;
  if (params.judgeName) query.judgeName = params.judgeName;
  if (params.referencedRegulation)
    query.referencedRegulation = params.referencedRegulation;
  if (params.legalBase) query.legalBase = params.legalBase;
  if (params.judgmentDateFrom) query.judgmentDateFrom = params.judgmentDateFrom;
  // Default the upper date bound to today. SAOS data contains OCR-mangled
  // dates (e.g. year 3013) which, under DESC date sorting, would otherwise
  // occupy the top result slots and push genuine recent judgments off-page.
  query.judgmentDateTo = params.judgmentDateTo ?? today();

  const qs = new URLSearchParams(query).toString();
  return fetchJson(`${SAOS_BASE}/search/judgments?${qs}`);
}

export async function saosGetJudgment(id: string | number): Promise<unknown> {
  const data = (await fetchJson(`${SAOS_BASE}/judgments/${id}`)) as Record<string, unknown>;
  return data["data"] ?? data;
}

// ---------------------------------------------------------------------------
// Local mirror
// ---------------------------------------------------------------------------

let store: Store | null = null;
let lastOpenError = 0;

// Not cached while missing: the sync child creates the file after the server
// started, and the server must pick it up without a restart.
export function localStore(): Store | null {
  if (store || process.env.SAOS_LOCAL === "0") return store;
  const path = defaultDbPath();
  if (!existsSync(path) || Date.now() - lastOpenError < 60_000) return null;
  try {
    store = new Store(path);
  } catch (err) {
    lastOpenError = Date.now();
    process.stderr.write(`mcp-saos: local dump unavailable (${String(err)}), using SAOS API\n`);
  }
  return store;
}

function localSearch(s: Store, p: SearchParams) {
  const size = Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, p.pageSize ?? PAGE_SIZE_DEFAULT));
  const page = Math.max(0, Math.floor(p.pageNumber ?? 0));
  const range = dateRange(p.judgmentDateFrom, p.judgmentDateTo ?? today());

  const clauses: string[] = [];
  const add = (col: string, expr: string | null) => expr && clauses.push(`${col} : (${expr})`);
  if (p.all) add("{cn judges legal regs kw body}", buildTextQuery(p.all));
  if (p.caseNumber) add("cn", buildPhrase(p.caseNumber));
  if (p.courtType) add("ct", `ct_${p.courtType.toLowerCase()}`);
  if (p.judgeName) add("judges", buildAllTokens(p.judgeName));
  if (p.referencedRegulation) add("regs", buildTextQuery(p.referencedRegulation));
  if (p.legalBase) add("legal", buildTextQuery(p.legalBase));

  const hits = clauses.length
    ? s.searchFts(clauses.join(" AND "), range, size, page * size, Boolean(p.all))
    : s.searchAll(range, size, page * size);

  const items = hits.rows.flatMap(({ id, snippet }) => {
    const j = s.getJudgment(id);
    if (!j) return [];
    return [{
      id: j.id,
      courtType: j.courtType,
      courtCases: j.courtCases,
      judgmentType: j.judgmentType,
      judges: j.judges,
      keywords: j.keywords,
      division: j.division,
      judgmentDate: j.judgmentDate,
      textContent: snippet,
    }];
  });
  const links = [{ rel: "self", href: "local" }];
  if ((page + 1) * size < hits.total) links.push({ rel: "next", href: "local" });
  return { items, info: { totalResults: hits.total }, links };
}

function warn(msg: string) {
  process.stderr.write(`[mcp-saos ${new Date().toISOString()}] ${msg}\n`);
}

export async function searchJudgments(p: SearchParams, tool: string): Promise<EngineResult> {
  const s = localStore();
  if (!s || !s.isReady()) return { data: await saosSearch(p), source: "saos_api" };

  const local = localSearch(s, p);
  if (local.info.totalResults > 0) {
    // F-02: a non-empty local answer is NOT automatically complete. When the
    // mirror itself reports anything but verified completeness, cross-check
    // the total against the SAOS API and signal the gap instead of claiming
    // the local count is the whole truth.
    const integrity = s.mirrorIntegrity();
    if (integrity.status !== "complete") {
      const probe = await probeMirrorGap(s, p, local.info.totalResults);
      if (probe.partial && probe.upstreamTotal !== null) {
        s.logDiscrepancy(tool, p, probe.upstreamTotal, probe.sampleIds);
        // F-04: stderr carries only the params hash, never raw query content.
        warn(`DISCREPANCY ${tool}: local ${local.info.totalResults}, SAOS ${probe.upstreamTotal} (params_hash=${hashParams(p)})`);
        return {
          data: {
            ...local,
            mirror_gap: {
              local_total: local.info.totalResults,
              upstream_total: probe.upstreamTotal,
              gap: probe.gap,
              integrity: integrity.status,
              detail: integrity.detail,
            },
          },
          source: "local_dump",
        };
      }
      if (probe.upstreamTotal === null) {
        // Upstream unreachable while the mirror is unverified: the local
        // answer stands, but flagged as uncertain - never as authoritative.
        return {
          data: {
            ...local,
            mirror_uncertain: true,
            mirror_integrity: integrity.status,
            mirror_detail: integrity.detail,
          },
          source: "local_dump",
        };
      }
    }
    return { data: local, source: "local_dump" };
  }

  try {
    const up = (await saosSearch(p)) as { items?: Array<{ id?: number }>; info?: { totalResults?: number } };
    const ids = (up.items ?? []).map((it) => it.id).filter((x): x is number => typeof x === "number");
    if (ids.length > 0) {
      const total = up.info?.totalResults ?? ids.length;
      s.logDiscrepancy(tool, p, total, ids);
      // F-04: stderr carries only the params hash, never raw query content.
      warn(`DISCREPANCY ${tool}: local 0, SAOS ${total} (params_hash=${hashParams(p)})`);
      return { data: up, source: "saos_api_fallback" };
    }
  } catch (err) {
    warn(`cross-check ${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { data: local, source: "local_dump" };
}

/**
 * F-02: pure gap arithmetic (exported for tests). Per-query totals can be
 * tiny (memo: local 2 vs upstream 5 must flag), so the tolerance is tighter
 * than the window-sync one: an absolute floor of 2 plus 5% relative.
 * A negative gap (local ahead via incremental corrections) is never partial.
 */
export function gapAssessment(
  localTotal: number,
  upstreamTotal: number | null,
): { gap: number | null; partial: boolean } {
  if (upstreamTotal === null) return { gap: null, partial: false };
  const gap = upstreamTotal - localTotal;
  const tolerance = Math.max(2, upstreamTotal * 0.05);
  return { gap, partial: gap > tolerance };
}

/**
 * F-02: completeness probe for a non-empty-but-partial mirror. Compares the
 * local total against the SAOS API total for the same params WITHOUT
 * returning upstream data (audit only). Returns the gap so callers and tests
 * can detect a mirror that answers but under-reports. A null upstreamTotal
 * means the API was unreachable - the caller must flag uncertainty instead
 * of presenting the local total as authoritative.
 */
export async function probeMirrorGap(
  s: Store,
  p: SearchParams,
  localTotal: number,
): Promise<{ upstreamTotal: number | null; gap: number | null; partial: boolean; sampleIds: number[] }> {
  void s;
  try {
    const up = (await saosSearch({ ...p, pageSize: 10, pageNumber: 0 })) as {
      items?: Array<{ id?: number }>;
      info?: { totalResults?: number };
    };
    const upstreamTotal = up.info?.totalResults ?? null;
    const sampleIds = (up.items ?? []).map((it) => it.id).filter((x): x is number => typeof x === "number");
    const { gap, partial } = gapAssessment(localTotal, upstreamTotal);
    return { upstreamTotal, gap, partial, sampleIds };
  } catch {
    return { upstreamTotal: null, gap: null, partial: false, sampleIds: [] };
  }
}

export async function getJudgment(id: string | number, tool: string): Promise<EngineResult> {
  const s = localStore();
  const n = Number(id);
  if (!s || !s.isReady() || !Number.isInteger(n)) return { data: await saosGetJudgment(id), source: "saos_api" };

  const local: DumpJudgment | null = s.getJudgment(n);
  if (local) return { data: local, source: "local_dump" };

  const up = (await saosGetJudgment(id)) as { id?: number } | null;
  if (up && typeof up === "object" && up.id !== undefined) {
    s.logDiscrepancy(tool, { id }, 1, [up.id]);
    warn(`DISCREPANCY ${tool}: judgment ${id} missing locally, present in SAOS`);
    return { data: up, source: "saos_api_fallback" };
  }
  return { data: up, source: "saos_api" };
}
