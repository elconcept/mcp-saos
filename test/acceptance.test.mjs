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
} from "../dist/index.js";
import { isValidIsoDate, Store, hashParams } from "../dist/store.js";
import {
  classifyHttpError,
  HttpError,
} from "../dist/http.js";
import {
  isSelfDescription,
  attitudeForLabel,
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
  const full = citeCoverage(12, 12, 2, 12, 8, false);
  assert.equal(full.unexaminedCandidates, 0);
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


// Local mirror contains only a subset of SAOS: the live cross-check must not
// turn a blocked API / malformed response into a plausible "no results" answer.
test("local miss: live positive result wins, even for an out-of-range page", async () => {
  const { crossCheckLocalMiss } = await import("../dist/engine.js");
  const observed = [];
  const live = { items: [], info: { totalResults: 7 }, links: [] };
  const result = await crossCheckLocalMiss(
    { caseNumber: "III CZP 6/21", pageNumber: 100 }, "search_by_case",
    (total, ids) => observed.push([total, ids]),
    async () => live,
  );
  assert.equal(result.source, "saos_api_fallback");
  assert.deepEqual(result.data, live);
  assert.deepEqual(observed, [[7, []]]);
});

test("local miss: explicit live zero is verified, not just assumed from dump", async () => {
  const { crossCheckLocalMiss } = await import("../dist/engine.js");
  let called = false;
  const result = await crossCheckLocalMiss({}, "search", () => {
    called = true;
  }, async () => ({ items: [], info: { totalResults: 0 } }));
  assert.equal(result.source, "saos_api_verified_empty");
  assert.equal(called, false);
});

test("local miss: upstream errors and malformed JSON are never swallowed", async () => {
  const { crossCheckLocalMiss } = await import("../dist/engine.js");
  await assert.rejects(
    () => crossCheckLocalMiss({}, "search", () => {}, async () => {
      throw new Error("SAOS API timeout");
    }),
    /SAOS API timeout/,
  );
  await assert.rejects(
    () => crossCheckLocalMiss({}, "search", () => {}, async () => ({})),
    /Invalid SAOS API search response/,
  );
});
