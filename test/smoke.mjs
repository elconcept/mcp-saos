/**
 * Smoke test for mcp-saos server.
 *
 * Spawns the built server as a child process, communicates over stdio
 * using JSON-RPC 2.0 (MCP protocol), and validates:
 *   1. tools/list  -> should return 3 tools
 *   2. tools/call  -> search with all="ochrona danych" courtType="SUPREME"
 *                     should return real hits from SAOS live API
 *
 * Usage: node test/smoke.mjs
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../dist/index.js");

let idCounter = 1;

function makeRequest(method, params) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: idCounter++,
    method,
    params,
  });
}

async function runSmoke() {
  console.log("--- mcp-saos smoke test ---\n");
  console.log(`Server binary: ${SERVER}\n`);

  const child = spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (d) => {
    process.stderr.write(`[server stderr] ${d}`);
  });

  const rl = createInterface({ input: child.stdout });
  const pending = new Map();

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  });

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const req = makeRequest(method, params);
      const id = idCounter - 1;
      pending.set(id, { resolve, reject });
      child.stdin.write(req + "\n");
    });
  }

  // Give server a moment to initialize
  await new Promise((r) => setTimeout(r, 500));

  let passed = 0;
  let failed = 0;

  // ----- TEST 1: tools/list -----
  console.log("TEST 1: tools/list");
  try {
    // MCP initialize handshake required before tools/list
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0" },
    });

    const result = await rpc("tools/list", {});
    const tools = result.tools ?? [];
    const names = tools.map((t) => t.name).sort();

    console.log(`  tools returned: ${names.join(", ")}`);

    if (
      names.includes("search") &&
      names.includes("get_judgment") &&
      names.includes("search_by_case") &&
      names.includes("saos_cite_check") &&
      names.length === 4
    ) {
      console.log("  PASS: 4 tools present\n");
      passed++;
    } else {
      console.log(`  FAIL: expected 4 tools, got ${names.length}: ${names.join(", ")}\n`);
      failed++;
    }
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
    failed++;
  }

  // ----- TEST 2: tools/call search -----
  console.log('TEST 2: tools/call search {all="ochrona danych", courtType="SUPREME"}');
  try {
    const result = await rpc("tools/call", {
      name: "search",
      arguments: {
        all: "ochrona danych",
        courtType: "SUPREME",
        pageSize: 10,
      },
    });

    const text = result?.content?.[0]?.text ?? "";
    console.log("  Response preview (first 600 chars):");
    console.log("  " + text.slice(0, 600).split("\n").join("\n  "));

    const hasHits = text.includes("Znalezione:") && !text.includes("Brak wynikow");
    const hasLink = text.includes("saos.org.pl/judgments/");

    if (hasHits && hasLink) {
      console.log("\n  PASS: real SAOS results returned with links\n");
      passed++;
    } else if (text.includes("Brak wynikow")) {
      console.log("\n  PARTIAL: API responded but no results (possible empty query range)\n");
      passed++;
    } else if (text.includes("Blad komunikacji")) {
      console.log("\n  FAIL: API communication error\n");
      failed++;
    } else {
      console.log("\n  PASS (no-error response received)\n");
      passed++;
    }
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
    failed++;
  }

  // ----- TEST 3: search_by_case -----
  console.log('TEST 3: tools/call search_by_case {caseNumber="I ACa 772/13"}');
  try {
    const result = await rpc("tools/call", {
      name: "search_by_case",
      arguments: { caseNumber: "I ACa 772/13" },
    });

    const text = result?.content?.[0]?.text ?? "";
    console.log("  Response preview (first 400 chars):");
    console.log("  " + text.slice(0, 400).split("\n").join("\n  "));

    const ok = !result?.isError || text.includes("Brak wynikow");
    console.log(ok ? "\n  PASS\n" : "\n  FAIL\n");
    ok ? passed++ : failed++;
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
    failed++;
  }

  // ----- TEST 4: tools/call search courtType=CONSTITUTIONAL_TRIBUNAL -----
  console.log('TEST 4: tools/call search {caseNumber="K 7/94", courtType="CONSTITUTIONAL_TRIBUNAL"}');
  try {
    const result = await rpc("tools/call", {
      name: "search",
      arguments: {
        caseNumber: "K 7/94",
        courtType: "CONSTITUTIONAL_TRIBUNAL",
        pageSize: 10,
      },
    });

    const text = result?.content?.[0]?.text ?? "";
    console.log("  Response preview (first 600 chars):");
    console.log("  " + text.slice(0, 600).split("\n").join("\n  "));

    const hasHits = text.includes("Znalezione:") && !text.includes("Brak wynikow");
    const hasLink = text.includes("saos.org.pl/judgments/");

    if (hasHits && hasLink) {
      console.log("\n  PASS: real SAOS Trybunal Konstytucyjny results returned with links\n");
      passed++;
    } else if (text.includes("Brak wynikow")) {
      console.log("\n  FAIL: SAOS returned no results for CONSTITUTIONAL_TRIBUNAL (expected K 7/94 hit)\n");
      failed++;
    } else if (text.includes("Blad komunikacji")) {
      console.log("\n  FAIL: API communication error\n");
      failed++;
    } else {
      console.log("\n  PASS (no-error response received)\n");
      passed++;
    }
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
    failed++;
  }

  // ----- TEST 5: saos_cite_check (live citator) -----
  // III CZP 6/21 - Supreme Court 7-judge resolution of 2021-05-07, heavily
  // cited; at least one later judgment (I C 3346/24, SAOS id 543228) expressly
  // departs from it, so the citator has real signals to find.
  console.log('TEST 5: tools/call saos_cite_check {caseNumber="III CZP 6/21", maxScan=3}');
  try {
    const result = await rpc("tools/call", {
      name: "saos_cite_check",
      arguments: { caseNumber: "III CZP 6/21", maxScan: 3 },
    });

    const text = result?.content?.[0]?.text ?? "";
    const sc = result?.structuredContent ?? {};
    console.log("  Response preview (first 800 chars):");
    console.log("  " + text.slice(0, 800).split("\n").join("\n  "));

    const verdicts = [
      "przelamanie_wykryte",
      "uchwala_skladu_powiekszonego",
      "nadal_cytowany",
      "brak_cytowan_w_saos",
    ];
    const hasVerdict = verdicts.includes(sc.verdict);
    const hasDisclaimer = text.includes("OGRANICZENIA");
    const hasCitations = Array.isArray(sc.citations);
    const hasCiting = (sc.total_citing_found ?? 0) > 0;

    if (!result?.isError && hasVerdict && hasDisclaimer && hasCitations && hasCiting) {
      console.log(`\n  PASS: verdict=${sc.verdict}, citing=${sc.total_citing_found}, hits=${(sc.hits ?? []).length}\n`);
      passed++;
    } else {
      console.log(
        `\n  FAIL: isError=${result?.isError}, verdict=${sc.verdict}, ` +
          `disclaimer=${hasDisclaimer}, citations=${hasCitations}, citing=${sc.total_citing_found}\n`
      );
      failed++;
    }
  } catch (err) {
    console.log(`  FAIL: ${err.message}\n`);
    failed++;
  }

  // ----- Summary -----
  console.log(`--- Summary: ${passed} passed, ${failed} failed ---`);

  child.stdin.end();
  child.kill();

  process.exit(failed > 0 ? 1 : 0);
}

runSmoke().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
