// Acceptance tests for the F-01..F-11 memo (offline, no network).
//
// Each test maps to a numbered acceptance scenario from memo section 7.
// Pure logic is tested via dist/ exports; the MCP contract (tool names kept,
// new error codes reachable without I/O) is tested over stdio.
//
// Run: npm run test:unit   (node --test, no network required)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import {
  formatJudgment,
  formatSearchResults,
  parseIdArg,
  citeCoverage,
  citingPageError,
  applyUnknownTargetRule,
  buildStatusPayload,
  isStatusAuthorized,
} from "../dist/index.js";
import { gapAssessment } from "../dist/engine.js";
import { completionGate } from "../dist/sync.js";
import { isValidIsoDate, Store, hashParams } from "../dist/store.js";
import {
  classifyHttpError,
  HttpError,
} from "../dist/http.js";
import {
  isSelfDescription,
  attitudeForLabel,
  computeVerdict,
} from "../dist/cite-check.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 1. Full reconstruction of a judgment from consecutive chunks (F-01)
// ---------------------------------------------------------------------------

test("AC1: concatenated chunks reconstruct the original text exactly", () => {
  const body = "x".repeat(5000) + " zażółć gęślą jaźń " + "y".repeat(10326);
  const raw = { id: 243836, textContent: `<p>${body}</p>` };
  const first = formatJudgment(raw, 0, 2000);
  assert.equal(first.totalLength, body.length);
  assert.equal(first.offset, 0);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextOffset, 2000);
  assert.equal(first.truncated, true);

  let cursor = 0;
  let totalReturned = 0;
  for (let i = 0; i < 20; i++) {
    const c = formatJudgment(raw, cursor, 2000);
    assert.equal(c.offset, cursor);
    // Chunk content is a verbatim slice of the stripped source text.
    assert.ok(c.text.includes(body.slice(cursor, cursor + 60)));
    cursor += c.returnedLength;
    totalReturned += c.returnedLength;
    if (!c.hasMore) break;
    assert.equal(c.nextOffset, cursor);
  }
  assert.equal(totalReturned, body.length);
  assert.equal(cursor, body.length);

  const tail = formatJudgment(raw, 0, 20000);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.nextOffset, null);
  assert.equal(tail.truncated, false);
});

test("AC1b: default get_judgment chunk stays backward compatible (2000)", () => {
  const raw = { id: 1, textContent: "a".repeat(5000) };
  const d = formatJudgment(raw);
  assert.equal(d.offset, 0);
  assert.equal(d.returnedLength, 2000);
  assert.equal(d.totalLength, 5000);
});

// ---------------------------------------------------------------------------
// 2. Pagination 10+10 == pageSize 20 identifiers (F-08 plumbing)
// ---------------------------------------------------------------------------

function fakePage(ids, total) {
  return {
    items: ids.map((id) => ({
      id,
      courtCases: [{ caseNumber: `X ${id}/20` }],
      judgmentDate: "2020-01-01",
    })),
    info: { totalResults: total },
    links: [{ rel: "self", href: "local" }],
  };
}

test("AC2: pagination metadata distinguishes pages; 10+10 covers 20", () => {
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const p0 = formatSearchResults(fakePage(ids.slice(0, 10), 20), 0, 10);
  const p1 = formatSearchResults(fakePage(ids.slice(10, 20), 20), 1, 10);
  assert.equal(p0.pagination.totalResults, 20);
  assert.equal(p0.pagination.totalPages, 2);
  assert.equal(p0.pagination.hasMore, true);
  assert.equal(p0.pagination.nextPage, 1);
  assert.equal(p1.pagination.hasMore, false);
  assert.equal(p1.pagination.nextPage, null);
  assert.match(p0.text, /strona 0\/2/);
});

// ---------------------------------------------------------------------------
// 3. Invalid dates never silently pass (F-07)
// ---------------------------------------------------------------------------

test("AC3: invalid dates rejected, valid ISO accepted", () => {
  for (const bad of ["xyz", "abc", "2021-13-01", "2021-02-30", "15-01-01", "2015/01/01", "", "3013-99-99"]) {
    assert.equal(isValidIsoDate(bad), false, bad);
  }
  for (const good of ["2015-01-01", "2021-05-07", "2000-02-29"]) {
    assert.equal(isValidIsoDate(good), true, good);
  }
  assert.equal(isValidIsoDate(undefined), false);
});

// ---------------------------------------------------------------------------
// 4. Out-of-range page reports the real total (F-08)
// ---------------------------------------------------------------------------

test("AC4: empty page with totalResults>0 is page_out_of_range, not no-results", () => {
  const { text, pagination } = formatSearchResults(fakePage([], 987), 1000, 10);
  assert.equal(pagination.totalResults, 987);
  assert.equal(pagination.totalPages, 99);
  assert.match(text, /Strona poza zakresem/);
  assert.match(text, /987/);
  const empty = formatSearchResults(fakePage([], 0), 0, 10);
  assert.match(empty.text, /totalResults=0/);
});

// ---------------------------------------------------------------------------
// 5. Upstream 404/400 classification + id validation (F-09)
// ---------------------------------------------------------------------------

test("AC5: HTTP errors classify to not_found / invalid_arg / upstream_error", () => {
  assert.deepEqual(classifyHttpError(new HttpError("HTTP 404: x", 404)), {
    code: "not_found",
    fault: "upstream",
    retryable: false,
    status: 404,
  });
  const bad = classifyHttpError(new HttpError("HTTP 400: x", 400));
  assert.equal(bad.code, "invalid_arg");
  assert.equal(bad.fault, "caller");
  const denied = classifyHttpError(new HttpError("HTTP 403: x", 403));
  assert.equal(denied.retryable, false);
  const limited = classifyHttpError(new HttpError("HTTP 429: x", 429, 120));
  assert.equal(limited.retryable, true);
  assert.equal(limited.retryAfterS, 120);
  const down = classifyHttpError(new HttpError("HTTP 503: x", 503));
  assert.equal(down.code, "upstream_error");
  assert.equal(down.retryable, true);
});

test("AC5b: id 0 and 'abc' are invalid_arg, missing is missing_arg", () => {
  assert.deepEqual(parseIdArg(undefined), { ok: false, empty: true });
  assert.deepEqual(parseIdArg(""), { ok: false, empty: true });
  assert.deepEqual(parseIdArg(0), { ok: false, empty: false });
  assert.deepEqual(parseIdArg("abc"), { ok: false, empty: false });
  assert.deepEqual(parseIdArg(-5), { ok: false, empty: false });
  assert.deepEqual(parseIdArg("243836"), { ok: true, id: 243836 });
  assert.deepEqual(parseIdArg(105173), { ok: true, id: 105173 });
});

// ---------------------------------------------------------------------------
// 6. Citator ignores self-describing enlarged-panel phrases (F-06)
// ---------------------------------------------------------------------------

test("AC6: self-description of the examined resolution is not a break signal", () => {
  const selfOnly =
    "w sprawie podjeto uchwale skladu siedmiu sedziow Sadu Najwyzszego z dnia 7 maja 2021 r., III CZP 6/21, w ktorej rozstrzygnieto zagadnienie";
  assert.equal(isSelfDescription(selfOnly, "III CZP 6/21", "2021-05-07"), true);

  const otherPanel =
    "w uchwale skladu siedmiu sedziow z dnia 3 marca 2022 r., III CZP 12/22, odstepuje sie od pogladu wyrazonego w III CZP 6/21";
  assert.equal(isSelfDescription(otherPanel, "III CZP 6/21", "2021-05-07"), false);
});

test("AC6b: hit attitudes distinguish mentioned from potentially_overruled", () => {
  assert.equal(attitudeForLabel("odstapienie_od_pogladu", "strong"), "potentially_overruled");
  assert.equal(attitudeForLabel("nie_podziela_pogladu", "strong"), "criticized");
  assert.equal(attitudeForLabel("uchwala_skladu_siedmiu", "caution"), "unknown");
  assert.equal(attitudeForLabel("zagadnienie_prawne", "caution"), "unknown");
});

// ---------------------------------------------------------------------------
// 7. Citator reports unexamined citations (F-05)
// ---------------------------------------------------------------------------

test("AC7: partial coverage is explicit (5388 total, 100 loaded, 3 scanned)", () => {
  const c = citeCoverage(5388, 100, 3, 100, 3, true);
  assert.equal(c.unexaminedCandidates, 5288);
  assert.equal(c.analysisComplete, false);
  assert.equal(c.status, "partial");
  assert.equal(c.analysisMode, "sampled_full_text");
  const full = citeCoverage(12, 12, 2, 12, 8, false);
  assert.equal(full.unexaminedCandidates, 0);
});

// ---------------------------------------------------------------------------
// CIT-01: snippets-only is a preliminary review, never a complete analysis
// (memo: IV CSK 792/14, deepScan=false, scannedFullText=0 -> was complete)
// ---------------------------------------------------------------------------

test("CIT-01: 13/13 candidates with 0 full texts is partial + snippets_only", () => {
  const c = citeCoverage(13, 13, 0, 13, 8, false);
  assert.equal(c.unexaminedCandidates, 0);
  assert.equal(c.candidateCoverage, 1);
  assert.equal(c.fullTextCoverage, 0);
  assert.equal(c.analysisMode, "snippets_only");
  assert.equal(c.analysisComplete, false);
  assert.equal(c.status, "partial");
});

test("CIT-01b: deepScan capped by maxScan stays sampled + partial", () => {
  const c = citeCoverage(13, 13, 5, 13, 5, true);
  assert.equal(c.analysisMode, "sampled_full_text");
  assert.equal(c.fullTextCoverage, 5 / 13);
  assert.equal(c.analysisComplete, false);
  assert.equal(c.status, "partial");
});

test("CIT-01c: exhaustive full-text scan completes", () => {
  const c = citeCoverage(13, 13, 13, 13, 20, true);
  assert.equal(c.analysisMode, "exhaustive_full_text");
  assert.equal(c.fullTextCoverage, 1);
  assert.equal(c.analysisComplete, true);
  assert.equal(c.status, "complete");
});

test("CIT-01d: zero citing needs no full texts (vacuous completion)", () => {
  const c = citeCoverage(0, 0, 0, 0, 8, false);
  assert.equal(c.candidateCoverage, 1);
  assert.equal(c.fullTextCoverage, 1);
  assert.equal(c.analysisComplete, true);
});

// ---------------------------------------------------------------------------
// CIT-02: empty citing page with positive total = page_out_of_range
// (memo: IV CSK 792/14, pageNumber=100 -> was brak_cytowan_w_saos)
// ---------------------------------------------------------------------------

test("CIT-02: empty page with total>0 is page_out_of_range, never a verdict", () => {
  const err = citingPageError(13, 0, 100, 100);
  assert.ok(err);
  assert.match(err, /pageNumber=100/);
  assert.match(err, /0\.\.0/);
  assert.match(err, /13/);
  assert.equal(citingPageError(13, 13, 0, 100), null);
  assert.equal(citingPageError(13, 10, 0, 100), null);
  assert.equal(citingPageError(0, 0, 0, 100), null);
  assert.equal(citingPageError(0, 0, 5, 100), null);
});

// ---------------------------------------------------------------------------
// CIT-03: caution alone never escalates (memo: III CZP 6/21 self-description)
// ---------------------------------------------------------------------------

test("CIT-03: caution-only verdict is neutral, strong still wins", () => {
  assert.equal(computeVerdict(5388, [{ severity: "caution" }]), "nieustalone");
  assert.equal(
    computeVerdict(5, [{ severity: "caution" }, { severity: "strong" }]),
    "przelamanie_wykryte"
  );
  assert.equal(computeVerdict(3, []), "nadal_cytowany");
  assert.equal(computeVerdict(0, []), "brak_cytowan_w_saos");
});

// ---------------------------------------------------------------------------
// CIT-04: unknown target + zero hits is nieustalone (memo: XX CSK 999999/99)
// ---------------------------------------------------------------------------

test("CIT-04: unverified signature with no hits is nieustalone", () => {
  assert.equal(applyUnknownTargetRule("brak_cytowan_w_saos", false, 0), "nieustalone");
  assert.equal(applyUnknownTargetRule("nieustalone", false, 0), "nieustalone");
  assert.equal(applyUnknownTargetRule("nadal_cytowany", false, 5), "nadal_cytowany");
  assert.equal(applyUnknownTargetRule("przelamanie_wykryte", false, 5), "przelamanie_wykryte");
  assert.equal(applyUnknownTargetRule("brak_cytowan_w_saos", true, 0), "brak_cytowan_w_saos");
});

// ---------------------------------------------------------------------------
// 8+9. Partial mirror detectable; degraded window is not success (F-02/F-03)
// ---------------------------------------------------------------------------

// node:sqlite needs Node >= 22.13; the server degrades without it, so do these tests.
const hasSqlite = await import("node:sqlite").then(() => true, () => false);

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "saos-"));
  return new Store(join(dir, "t.sqlite"));
}

test("AC8/AC9: degraded windows make the mirror partial, never complete", { skip: !hasSqlite && "node:sqlite unavailable" }, () => {
  const s = tempStore();
  try {
    assert.equal(s.mirrorIntegrity().status, "unverified");
    s.setState("initial_complete", "1");
    s.setState("last_sync", new Date().toISOString());
    s.db.prepare("INSERT INTO windows(start, end, status, completed_at) VALUES(?, ?, ?, ?)").run(
      "2020-01-01",
      "2020-01-31",
      "verified",
      new Date().toISOString()
    );
    s.db.prepare("INSERT INTO windows(start, end, status, completed_at) VALUES(?, ?, ?, ?)").run(
      "2020-02-01",
      "2020-02-29",
      "degraded",
      new Date().toISOString()
    );
    const integ = s.mirrorIntegrity();
    assert.equal(integ.status, "partial");
    assert.match(integ.detail, /degraded/);
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
// F-02: local 2 vs upstream 5 is a flagged gap, not "only 2 exist"
// ---------------------------------------------------------------------------

test("F-02: gap arithmetic flags under-reporting beyond tolerance", () => {
  const memo = gapAssessment(2, 5);
  assert.equal(memo.gap, 3);
  assert.equal(memo.partial, true);
  assert.equal(gapAssessment(100, 100).partial, false);
  assert.equal(gapAssessment(1000, 1005).partial, false);
  assert.equal(gapAssessment(1000, 1100).partial, true);
  // Local ahead of upstream (incremental corrections) is not a gap.
  assert.equal(gapAssessment(543536, 543276).partial, false);
  // Unreachable upstream carries no verdict about completeness.
  assert.deepEqual(gapAssessment(7, null), { gap: null, partial: false });
});

test("F-02b: partial-mirror answers carry a visible gap warning", () => {
  const raw = {
    items: [
      { id: 1, courtCases: [{ caseNumber: "X 1/20" }], judgmentDate: "2020-01-01" },
      { id: 2, courtCases: [{ caseNumber: "X 2/20" }], judgmentDate: "2020-01-02" },
    ],
    info: { totalResults: 2 },
    links: [{ rel: "self", href: "local" }],
    mirror_gap: {
      local_total: 2, upstream_total: 5, gap: 3,
      integrity: "partial", detail: "2 degraded of 334 windows",
    },
  };
  const { text } = formatSearchResults(raw, 0, 10);
  assert.match(text, /niepelna/);
  assert.match(text, /w SAOS 5/);
});

test("F-02c: uncertain mirror (upstream down) warns instead of asserting", () => {
  const raw = {
    items: [{ id: 1, courtCases: [{ caseNumber: "X 1/20" }], judgmentDate: "2020-01-01" }],
    info: { totalResults: 1 },
    links: [{ rel: "self", href: "local" }],
    mirror_uncertain: true,
    mirror_integrity: "partial",
    mirror_detail: "3 degraded of 334 windows",
  };
  const { text } = formatSearchResults(raw, 0, 10);
  assert.match(text, /niepewna/);
});

// ---------------------------------------------------------------------------
// F-03: legacy windows block false completeness; degraded ranges listed
// ---------------------------------------------------------------------------

test("F-03b: legacy (pre-status) windows read as partial until re-verified", { skip: !hasSqlite && "node:sqlite unavailable" }, () => {
  const s = tempStore();
  try {
    s.setState("initial_complete", "1");
    s.setState("last_sync", new Date().toISOString());
    s.db.prepare("INSERT INTO windows(start, end, status, completed_at) VALUES(?, ?, ?, ?)").run(
      "2020-01-01", "2020-01-31", "retry_pending", new Date().toISOString()
    );
    const integ = s.mirrorIntegrity();
    assert.equal(integ.status, "partial");
    assert.match(integ.detail, /legacy/);
    // After an honest recheck promotes the window, the mirror reads complete.
    s.db.prepare("UPDATE windows SET status = 'verified', checked_at = ? WHERE start = ?").run(
      new Date().toISOString(), "2020-01-01"
    );
    assert.equal(s.mirrorIntegrity().status, "complete");
  } finally {
    s.close();
  }
});

test("F-03c: degraded window ranges are listed for the repair queue", { skip: !hasSqlite && "node:sqlite unavailable" }, () => {
  const s = tempStore();
  try {
    s.db.prepare("INSERT INTO windows(start, end, status, completed_at) VALUES(?, ?, ?, ?)").run(
      "2020-02-01", "2020-02-29", "degraded", new Date().toISOString()
    );
    const st = s.stats();
    assert.equal(st.windows_degraded, 1);
    assert.ok(Array.isArray(st.degraded_windows));
    assert.ok(st.degraded_windows.includes("2020-02-01..2020-02-29"));
  } finally {
    s.close();
  }
});

test("F-03d: completion gate blocks false initial_complete", () => {
  assert.deepEqual(completionGate(0, 0, 0, 0), { complete: true, reason: "all windows verified" });
  assert.equal(completionGate(0, 0, 1, 0).complete, false);
  assert.equal(completionGate(0, 0, 0, 334).complete, false);
  assert.equal(completionGate(1, 0, 0, 0).complete, false);
  assert.equal(completionGate(0, 2, 0, 0).complete, false);
});

// ---------------------------------------------------------------------------
// 10. Public diagnostics carry no raw queries or PII (F-04)
// ---------------------------------------------------------------------------

test("AC10: stats() redacts discrepancy params to hashes", { skip: !hasSqlite && "node:sqlite unavailable" }, () => {
  const s = tempStore();
  try {
    s.logDiscrepancy("search", { all: "Jan Kowalski PESEL 123", caseNumber: "I ACa 1/20" }, 2, [1, 2]);
    const st = s.stats();
    assert.equal(st.discrepancies, 1);
    const [row] = st.recent_discrepancies;
    assert.ok(row);
    assert.equal(row.params_hash, hashParams(JSON.stringify({ all: "Jan Kowalski PESEL 123", caseNumber: "I ACa 1/20" })));
    assert.ok(!("params" in row), "raw params must not leak");
    assert.ok(!("upstream_ids" in row), "raw upstream ids must not leak");
    assert.equal(row.upstream_ids_count, 2);
    const blob = JSON.stringify(st);
    assert.ok(!blob.includes("Kowalski"), "no PII in diagnostics blob");
  } finally {
    s.close();
  }
});

test("F-04b: unauthenticated /status carries counts, never per-query detail", () => {
  const stats = {
    judgments: 5,
    windows_total: 2,
    index_status: "complete",
    discrepancies: 1,
    recent_discrepancies: [
      { at: "t", tool: "search", params_hash: "abc", upstream_total: 1, upstream_ids_count: 1 },
    ],
  };
  const pub = buildStatusPayload({ service: "mcp-saos" }, stats, false, false);
  assert.equal(pub.judgments, 5);
  assert.ok(!("recent_discrepancies" in pub), "per-query detail needs auth");
  assert.match(String(pub.diagnostics), /STATUS_TOKEN/);
  const full = buildStatusPayload({ service: "mcp-saos" }, stats, true, true);
  assert.ok("recent_discrepancies" in full);
  assert.deepEqual(buildStatusPayload({ service: "x" }, null, false, false), { service: "x", local: false });
});

test("F-04c: only the Authorization header authenticates - never the URL", () => {
  assert.equal(isStatusAuthorized({ authorization: "Bearer s3cr3t" }, "s3cr3t"), true);
  assert.equal(isStatusAuthorized({}, "s3cr3t"), false);
  assert.equal(isStatusAuthorized({ authorization: "Bearer wrong" }, "s3cr3t"), false);
  assert.equal(isStatusAuthorized({ authorization: "Bearer s3cr3t" }, undefined), false);
  assert.equal(isStatusAuthorized({ authorization: ["Bearer s3cr3t"] }, "s3cr3t"), true);
});

// ---------------------------------------------------------------------------
// F-10: legalBase vs referencedRegulation index DIFFERENT dump metadata.
// Memo observation (1 vs 0 hits) is expected field separation, not a bug:
// legalBase searches the judgment's stated legal bases; referencedRegulation
// searches the acts it cites. A cited act is NOT automatically a basis.
// ---------------------------------------------------------------------------

test("F-10: legal and regs fields index separate metadata (controlled)", { skip: !hasSqlite && "node:sqlite unavailable" }, () => {
  const s = tempStore();
  try {
    s.upsertMany([
      {
        id: 900001,
        courtType: "SUPREME",
        courtCases: [{ caseNumber: "TEST 1/26" }],
        judgmentDate: "2026-01-15",
        legalBases: ["artzzq 445 kodeksu"],
        referencedRegulations: [{ text: "ustawazzr o ochronie" }],
        textContent: "neutralny tekst kontrolny",
      },
    ]);
    const range = [0, 99999999 * 10000000 + 9999999];
    const legalHit = s.searchFts("legal : artzzq", range, 10, 0, false);
    assert.equal(legalHit.total, 1);
    const regsMiss = s.searchFts("regs : artzzq", range, 10, 0, false);
    assert.equal(regsMiss.total, 0);
    const regsHit = s.searchFts("regs : ustawazzr", range, 10, 0, false);
    assert.equal(regsHit.total, 1);
    const legalMiss = s.searchFts("legal : ustawazzr", range, 10, 0, false);
    assert.equal(legalMiss.total, 0);
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
// F-11: explainer counts are marked as an illustration, never bare numbers
// ---------------------------------------------------------------------------

test("F-11: search explainer marks example counts as illustration", () => {
  const { text } = formatSearchResults(fakePage([1, 2], 2), 0, 10);
  assert.match(text, /Przyklad ilustracyjny/);
  assert.ok(!text.includes("(6 wynikow dla frazy)"), "bare example counts must not pose as results");
  assert.ok(!text.includes("(127 wynikow dla tej samej frazy)"));
});

// ---------------------------------------------------------------------------
// 11. Backward compatibility: 4 tools, old params still work (F-11)
// ---------------------------------------------------------------------------
// Raw JSON-RPC over stdio (same pattern as test/smoke.mjs) - no client SDK,
// works offline for validation-first paths (list, invalid id, invalid date).

function startServer() {
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  let idCounter = 1;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    } catch {
      // ignore non-JSON lines
    }
  });
  const rpc = (method, params, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const id = idCounter++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, timeoutMs);
    });
  const stop = () => {
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    try {
      rl.close();
    } catch {
      // already closed
    }
    child.kill();
  };
  return { rpc, stop };
}

test("AC11: four tools stay registered; get_judgment gains offset/limit only", async () => {
  const { rpc, stop } = startServer();
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    const { tools } = await rpc("tools/list", {});
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_judgment", "saos_cite_check", "search", "search_by_case"]);
    const gj = tools.find((t) => t.name === "get_judgment");
    assert.ok(gj.inputSchema.properties.id, "id still required");
    assert.ok(gj.inputSchema.properties.offset, "offset added");
    assert.ok(gj.inputSchema.properties.limit, "limit added");
    assert.deepEqual(gj.inputSchema.required, ["id"]);
    const cite = tools.find((t) => t.name === "saos_cite_check");
    assert.ok(cite.inputSchema.properties.pageNumber, "citator pageNumber added");
  } finally {
    stop();
  }
});

test("AC11b: invalid id and invalid date fail offline with caller faults", async () => {
  const { rpc, stop } = startServer();
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    const badId = await rpc("tools/call", { name: "get_judgment", arguments: { id: "abc" } });
    assert.equal(badId.isError, true);
    assert.match(badId.content[0].text, /\[invalid_arg\]/);
    assert.equal(badId.structuredContent.error_code, "invalid_arg");
    assert.equal(badId.structuredContent.fault, "caller");

    const zeroId = await rpc("tools/call", { name: "get_judgment", arguments: { id: 0 } });
    assert.equal(zeroId.isError, true);
    assert.match(zeroId.content[0].text, /\[invalid_arg\]/);

    const badDate = await rpc("tools/call", {
      name: "search",
      arguments: { dateFrom: "xyz", courtType: "SUPREME" },
    });
    assert.equal(badDate.isError, true);
    assert.match(badDate.content[0].text, /\[invalid_date\]/);
    assert.equal(badDate.structuredContent.fault, "caller");
  } finally {
    stop();
  }
});
