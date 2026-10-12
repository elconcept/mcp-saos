#!/usr/bin/env node
/**
 * MCP server for Polish court judgments - SAOS (System Analizy Orzeczen Sadowych).
 *
 * Public REST API by Fundacja ePanstwo. No API key required.
 * Broad coverage including current judgments (2024-2026 well populated).
 * Coverage is uneven by court type; administrative courts (WSA/NSA) are absent.
 * Note: OCR artifacts can produce malformed dates - verify in the source.
 *
 * Tools exposed:
 *   search          - full-text / filtered search over /api/search/judgments
 *   get_judgment    - single judgment by id via /api/judgments/{id}
 *   search_by_case  - shortcut: search by case number (sygnatura akt)
 *   saos_cite_check - citator "is the judgment alive": later citing judgments
 *                     + phrase scan for line-breaking language (see cite-check.ts)
 *
 * Engine (src/engine.ts): queries are answered from a local mirror of the SAOS
 * dump (src/sync.ts keeps it current daily); the SAOS API is the fallback and a
 * cross-check - an upstream hit missing locally is logged as a discrepancy.
 * Transport: stdio (default) or Streamable HTTP (MCP_TRANSPORT=http, see main()).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  parseCaseNumber,
  buildCaseNumberRegex,
  scanWindows,
  computeVerdict,
  VERDICT_TEXT,
  CITE_CHECK_DISCLAIMER,
  type ScanHit,
} from "./cite-check.js";
import { stripHtml } from "./text.js";
import {
  searchJudgments,
  getJudgment,
  localStore,
  PAGE_SIZE_DEFAULT,
  type Source,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Response formatters
// ---------------------------------------------------------------------------

interface JudgmentItem {
  id?: number;
  courtType?: string;
  courtCases?: Array<{ caseNumber?: string }>;
  judgmentType?: string;
  judgmentDate?: string;
  division?: {
    court?: { name?: string };
    name?: string;
  };
  textContent?: string;
  judges?: Array<{ name?: string }>;
  keywords?: string[];
}

interface SearchResponse {
  items?: JudgmentItem[];
  info?: { totalResults?: number };
  links?: Array<{ rel?: string; href?: string }>;
}

function formatSearchResults(raw: unknown): string {
  const data = raw as SearchResponse;
  const items = data.items ?? [];
  const total = data.info?.totalResults ?? 0;

  if (items.length === 0) {
    return (
      "Brak wynikow w bazie SAOS dla podanych kryteriow.\n\n" +
      "Uwaga: pokrycie SAOS jest nierowne wg typu sadu. Sady administracyjne " +
      "(WSA/NSA) nie sa indeksowane - dla orzeczen administracyjnych uzyj " +
      "orzeczenia.nsa.gov.pl. Sprobuj tez innych slow kluczowych lub szerszego zakresu dat."
    );
  }

  const lines: string[] = [
    `Znalezione: ${total} orzeczen (pokazano ${items.length}).`,
    "Uwaga: daty bywaja znieksztalcone przez OCR (np. rok 3013) - przy " +
      "sortowaniu wg daty weryfikuj sygnature i date w zrodle. Sady " +
      "administracyjne (WSA/NSA) nie sa w SAOS.",
    "",
  ];

  for (const it of items) {
    const sig = it.courtCases?.[0]?.caseNumber ?? "brak_sygnatury";
    const courtName =
      it.division?.court?.name ?? it.division?.name ?? it.courtType ?? "nieznany";
    const date = it.judgmentDate ?? "?";
    const type = it.judgmentType ?? "";
    const link = `https://www.saos.org.pl/judgments/${it.id}`;

    // Strip HTML and truncate snippet
    const rawText = it.textContent ?? "";
    const snippet = stripHtml(rawText).slice(0, 200);

    lines.push(`[${it.id}] ${sig}`);
    lines.push(`  Data: ${date} | Typ: ${type} | Sad: ${courtName}`);
    lines.push(`  Link: ${link}`);
    if (snippet) {
      lines.push(`  Fragment: ${snippet}...`);
    }
    lines.push("");
  }

  // Next page hint
  const hasNext = (data.links ?? []).some((l) => l.rel === "next");
  if (hasNext && items.length < total) {
    lines.push("Wiecej wynikow - zwieksz pageNumber o 1.");
  }

  return lines.join("\n");
}

interface JudgmentData {
  id?: number;
  courtType?: string;
  courtCases?: Array<{ caseNumber?: string }>;
  judgmentType?: string;
  judgmentDate?: string;
  division?: { court?: { name?: string }; name?: string };
  judges?: Array<{ name?: string }>;
  keywords?: string[];
  summary?: string;
  textContent?: string;
  source?: { judgmentUrl?: string };
  legalBases?: Array<{ textExcerpt?: string; lawJournalEntry?: { title?: string } }>;
  referencedRegulations?: Array<{ text?: string }>;
}

function formatJudgment(raw: unknown): string {
  const d = raw as JudgmentData;
  const sig = d.courtCases?.[0]?.caseNumber ?? "brak_sygnatury";
  const courtName =
    d.division?.court?.name ?? d.division?.name ?? d.courtType ?? "nieznany";
  const judgesList = (d.judges ?? [])
    .map((j) => j.name ?? "")
    .filter(Boolean)
    .join(", ");
  const kws = (d.keywords ?? []).join(", ");
  const sourceUrl = d.source?.judgmentUrl ?? "-";
  const saosUrl = `https://www.saos.org.pl/judgments/${d.id}`;

  const legalBases = (d.legalBases ?? [])
    .slice(0, 5)
    .map((lb) => lb.textExcerpt ?? lb.lawJournalEntry?.title ?? "")
    .filter(Boolean)
    .join("; ");

  const refs = (d.referencedRegulations ?? [])
    .slice(0, 5)
    .map((r) => r.text ?? "")
    .filter(Boolean)
    .join("; ");

  const summary = stripHtml(d.summary ?? "").slice(0, 800);
  const textRaw = stripHtml(d.textContent ?? "");
  // Return up to 2000 chars of the judgment text
  const textPreview = textRaw.slice(0, 2000);

  const lines: string[] = [
    "=== ORZECZENIE SAOS ===",
    "",
    `Sygnatura  : ${sig}`,
    `ID SAOS    : ${d.id}`,
    `Typ sadu   : ${d.courtType ?? "?"}`,
    `Sad        : ${courtName}`,
    `Data       : ${d.judgmentDate ?? "?"}`,
    `Typ        : ${d.judgmentType ?? "?"}`,
    `Sklad      : ${judgesList || "-"}`,
    `Slowa klucz: ${kws || "-"}`,
  ];

  if (legalBases) lines.push(`Podst. prawna: ${legalBases}`);
  if (refs) lines.push(`Przyw. akty  : ${refs}`);

  lines.push("", `SAOS URL   : ${saosUrl}`);
  lines.push(`Oryginal   : ${sourceUrl}`);

  if (summary) {
    lines.push("", "--- Streszczenie ---", summary);
  }

  if (textPreview) {
    lines.push(
      "",
      `--- Tresc (pierwsze 2000 znakow z ${textRaw.length} lacznie) ---`,
      textPreview
    );
    if (textRaw.length > 2000) {
      lines.push(`[...] Skrocono. Pelna tresc: ${saosUrl}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Structured citations builders
// ---------------------------------------------------------------------------
//
// Klient MCP (Patron) czyta result.structuredContent.citations zeby
// wystawic w panelu UI liste powiazanych orzeczen obok streamowanej odpowiedzi.
// Kontrakt: kazdy obiekt ma title (etykieta) i/lub url (zrodlo). Pozostale
// pola sa swobodne i ladowane do metadata po stronie klienta.

interface SaosCitation {
  title: string;
  url: string;
  snippet?: string;
  case_number?: string;
  court?: string;
  judgment_date?: string;
  judgment_type?: string;
  saos_id?: number;
  court_type?: string;
}

function buildSearchCitations(raw: unknown): SaosCitation[] {
  const data = raw as SearchResponse;
  const items = data.items ?? [];
  const out: SaosCitation[] = [];
  for (const it of items) {
    if (it.id === undefined) continue;
    const sig = it.courtCases?.[0]?.caseNumber ?? "";
    const courtName =
      it.division?.court?.name ?? it.division?.name ?? it.courtType ?? "";
    const date = it.judgmentDate ?? "";
    const snippet = stripHtml(it.textContent ?? "").slice(0, 200);
    const title = [sig, courtName].filter(Boolean).join(" - ") || `SAOS #${it.id}`;

    out.push({
      title,
      url: `https://www.saos.org.pl/judgments/${it.id}`,
      ...(snippet && { snippet }),
      ...(sig && { case_number: sig }),
      ...(courtName && { court: courtName }),
      ...(date && { judgment_date: date }),
      ...(it.judgmentType && { judgment_type: it.judgmentType }),
      saos_id: it.id,
      ...(it.courtType && { court_type: it.courtType }),
    });
  }
  return out;
}

function buildJudgmentCitation(raw: unknown): SaosCitation | null {
  const d = raw as JudgmentData;
  if (d.id === undefined) return null;
  const sig = d.courtCases?.[0]?.caseNumber ?? "";
  const courtName =
    d.division?.court?.name ?? d.division?.name ?? d.courtType ?? "";
  const snippet = stripHtml(d.textContent ?? "").slice(0, 200);
  const title = [sig, courtName].filter(Boolean).join(" - ") || `SAOS #${d.id}`;
  return {
    title,
    url: `https://www.saos.org.pl/judgments/${d.id}`,
    ...(snippet && { snippet }),
    ...(sig && { case_number: sig }),
    ...(courtName && { court: courtName }),
    ...(d.judgmentDate && { judgment_date: d.judgmentDate }),
    ...(d.judgmentType && { judgment_type: d.judgmentType }),
    saos_id: d.id,
    ...(d.courtType && { court_type: d.courtType }),
  };
}

// ---------------------------------------------------------------------------
// Data source reporting (local dump vs SAOS API)
// ---------------------------------------------------------------------------

function combineSources(sources: Set<Source>): Source {
  if (sources.has("saos_api_fallback")) return "saos_api_fallback";
  if (sources.has("saos_api")) return "saos_api";
  return "local_dump";
}

function sourceNote(source: Source): string {
  return source === "saos_api_fallback"
    ? "Uwaga: wynik pobrany z API SAOS - brak go w lokalnej kopii bazy (rozbieznosc zarejestrowana do weryfikacji)."
    : "";
}

function withSourceNote(text: string, source: Source): string {
  const note = sourceNote(source);
  return note ? `${text}\n\n${note}` : text;
}

// ---------------------------------------------------------------------------
// Citator - orchestration for saos_cite_check (pure logic in cite-check.ts)
// ---------------------------------------------------------------------------

const CITE_MAX_SCAN_DEFAULT = 8;
const CITE_MAX_SCAN_CAP = 20;
const CITE_FETCH_BATCH = 4;
const CITE_DISPLAY_LIMIT = 20;

interface CiteHitOut {
  citing_case_number: string;
  citing_saos_id?: number;
  citing_date?: string;
  citing_court?: string;
  severity: string;
  label: string;
  phrase: string;
  fragment: string;
  source: "deep_scan" | "search_snippet";
}

function itemCaseNumber(it: JudgmentItem): string {
  return it.courtCases?.[0]?.caseNumber ?? "";
}

function itemCourtName(it: JudgmentItem): string {
  return it.division?.court?.name ?? it.division?.name ?? it.courtType ?? "";
}

function isValidDate(d: string | undefined): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/** Exact-match test: does this item's case number equal the target signature? */
function matchesCaseNumber(it: JudgmentItem, caseRe: RegExp): boolean {
  const cn = itemCaseNumber(it);
  if (!cn) return false;
  caseRe.lastIndex = 0;
  const m = caseRe.exec(cn);
  // Full-string match (allowing surrounding whitespace only)
  return m !== null && cn.replace(m[0], "").trim() === "";
}

async function runCiteCheck(a: Record<string, unknown>) {
  const rawInput = String(a.caseNumber ?? "");
  const caseNo = parseCaseNumber(rawInput);
  if (!caseNo) {
    return errorResult(
      `Nie udalo sie wyodrebnic sygnatury akt z '${rawInput}'. ` +
        "Podaj sygnature w formie np. 'III CZP 6/21', 'I ACa 772/13', 'K 7/94'.",
      "missing_arg"
    );
  }

  const courtType = a.courtType ? String(a.courtType) : undefined;
  if (courtType && !VALID_COURT_TYPES.has(courtType)) {
    return errorResult(
      `courtType '${courtType}' niedozwolony. Uzyj: ${[...VALID_COURT_TYPES].join(", ")}.`,
      "invalid_court_type"
    );
  }

  const deepScan = a.deepScan === undefined ? true : Boolean(a.deepScan);
  const maxScan = Math.min(
    CITE_MAX_SCAN_CAP,
    Math.max(1, typeof a.maxScan === "number" ? a.maxScan : CITE_MAX_SCAN_DEFAULT)
  );

  const caseRe = buildCaseNumberRegex(caseNo);

  // 1. Locate the target judgment (for its date). Prefer SUPREME on ambiguity -
  //    identical signatures repeat across common courts.
  const sources = new Set<Source>();
  const targetRes = await searchJudgments({ caseNumber: caseNo, courtType, pageSize: 20 }, "saos_cite_check");
  sources.add(targetRes.source);
  const targetRaw = targetRes.data as SearchResponse;
  const targetPool = (targetRaw.items ?? []).filter((it) => matchesCaseNumber(it, caseRe));
  const courtRank = (it: JudgmentItem): number => {
    if (it.courtType === "SUPREME") return 0;
    if (it.courtType === "CONSTITUTIONAL_TRIBUNAL") return 1;
    return 2;
  };
  const target =
    [...targetPool].sort(
      (x, y) => courtRank(x) - courtRank(y) || (x.judgmentDate ?? "").localeCompare(y.judgmentDate ?? "")
    )[0] ?? null;
  const distinctCourts = new Set(targetPool.map((it) => itemCourtName(it))).size;
  const targetDate = target && isValidDate(target.judgmentDate) ? target.judgmentDate : null;

  // 2. Later judgments citing the signature - quoted full-text phrase search.
  const citingRes = await searchJudgments({ all: `"${caseNo}"`, pageSize: 100 }, "saos_cite_check");
  sources.add(citingRes.source);
  const citingRaw = citingRes.data as SearchResponse;
  const totalCitingRaw = citingRaw.info?.totalResults ?? 0;

  const citing = (citingRaw.items ?? [])
    .filter((it) => it.id !== undefined)
    .filter((it) => it.id !== target?.id)
    .filter((it) => !matchesCaseNumber(it, caseRe)) // exclude the case itself
    .filter((it) => (targetDate ? isValidDate(it.judgmentDate) && it.judgmentDate > targetDate : true))
    .sort((x, y) => (y.judgmentDate ?? "").localeCompare(x.judgmentDate ?? ""));

  // 3. Cheap pre-scan: search snippets already contain text around the match.
  //    One hit per (judgment, phrase label); a deep_scan hit replaces the
  //    snippet-based one for the same key (fuller fragment context).
  const hitMap = new Map<string, CiteHitOut>();
  const addHits = (it: JudgmentItem, scanned: ScanHit[], source: CiteHitOut["source"]) => {
    for (const h of scanned) {
      const key = `${it.id}:${h.label}`;
      const existing = hitMap.get(key);
      if (existing && !(existing.source === "search_snippet" && source === "deep_scan")) continue;
      hitMap.set(key, {
        citing_case_number: itemCaseNumber(it) || `SAOS #${it.id}`,
        citing_saos_id: it.id,
        citing_date: it.judgmentDate,
        citing_court: itemCourtName(it),
        severity: h.severity,
        label: h.label,
        phrase: h.phrase,
        fragment: h.fragment,
        source,
      });
    }
  };

  for (const it of citing) {
    if (it.textContent) addHits(it, scanWindows(it.textContent, caseNo), "search_snippet");
  }

  // 4. Deep scan: fetch full texts of the most decisive citing judgments
  //    (Supreme Court and resolutions first, then newest), in small batches.
  let scannedDeep = 0;
  if (deepScan && citing.length > 0) {
    const prioritized = [...citing]
      .sort((x, y) => {
        const xs = x.courtType === "SUPREME" ? 0 : 1;
        const ys = y.courtType === "SUPREME" ? 0 : 1;
        if (xs !== ys) return xs - ys;
        const xr = x.judgmentType === "RESOLUTION" ? 0 : 1;
        const yr = y.judgmentType === "RESOLUTION" ? 0 : 1;
        if (xr !== yr) return xr - yr;
        return (y.judgmentDate ?? "").localeCompare(x.judgmentDate ?? "");
      })
      .slice(0, maxScan);

    for (let i = 0; i < prioritized.length; i += CITE_FETCH_BATCH) {
      const batch = prioritized.slice(i, i + CITE_FETCH_BATCH);
      const details = await Promise.all(
        batch.map(async (it) => {
          try {
            const res = await getJudgment(it.id as number, "saos_cite_check");
            sources.add(res.source);
            return res.data as JudgmentData;
          } catch {
            return null; // single fetch failure must not sink the whole check
          }
        })
      );
      details.forEach((d, idx) => {
        if (!d?.textContent) return;
        scannedDeep++;
        addHits(batch[idx], scanWindows(d.textContent, caseNo), "deep_scan");
      });
    }
  }

  // 5. Verdict + output.
  const hits = [...hitMap.values()];
  const verdict = computeVerdict(citing.length, hits);
  const strongHits = hits.filter((h) => h.severity === "strong");
  const cautionHits = hits.filter((h) => h.severity === "caution");

  const lines: string[] = [`=== CITATOR SAOS: ${caseNo} ===`, ""];
  if (target) {
    lines.push(
      `Orzeczenie badane: ${itemCaseNumber(target)} | ${itemCourtName(target)} | ` +
        `${target.judgmentDate ?? "data nieznana"} | https://www.saos.org.pl/judgments/${target.id}`
    );
    if (distinctCourts > 1) {
      lines.push(
        `Uwaga: sygnatura '${caseNo}' wystepuje w ${distinctCourts} roznych sadach - ` +
          "wybrano orzeczenie wg priorytetu SN > TK > pozostale. Doprecyzuj courtType, jesli chodzi o inny sad."
      );
    }
  } else {
    lines.push(
      `Orzeczenie badane: '${caseNo}' NIE znalezione w SAOS - filtr 'pozniejsze niz badane' niedostepny, ` +
        "wyniki obejmuja wszystkie orzeczenia przywolujace te sygnature."
    );
  }
  lines.push("");
  lines.push(`WERDYKT [${verdict}]: ${VERDICT_TEXT[verdict]}`);
  lines.push("");
  lines.push(
    `Cytujace orzeczenia${targetDate ? " (pozniejsze niz " + targetDate + ")" : ""}: ` +
      `${citing.length} na tej stronie (lacznie w SAOS dla frazy: ${totalCitingRaw}), ` +
      `skan pelnych tekstow: ${scannedDeep}.`
  );

  if (hits.length > 0) {
    lines.push("");
    lines.push(`Trafienia fraz (${strongHits.length} strong, ${cautionHits.length} caution):`);
    for (const h of [...strongHits, ...cautionHits].slice(0, 15)) {
      lines.push(
        `- [${h.severity}/${h.label}] ${h.citing_case_number} (${h.citing_court}, ${h.citing_date ?? "?"})`
      );
      lines.push(`  fraza: "${h.phrase}"`);
      lines.push(`  fragment: "...${h.fragment}..."`);
    }
  }

  if (citing.length > 0) {
    lines.push("");
    lines.push(`Najnowsze cytujace (max ${CITE_DISPLAY_LIMIT}):`);
    for (const it of citing.slice(0, CITE_DISPLAY_LIMIT)) {
      lines.push(
        `- ${itemCaseNumber(it) || "brak_sygnatury"} | ${it.judgmentDate ?? "?"} | ` +
          `${itemCourtName(it)} | https://www.saos.org.pl/judgments/${it.id}`
      );
    }
  }

  lines.push("");
  lines.push(CITE_CHECK_DISCLAIMER);
  const srcNote = sourceNote(combineSources(sources));
  if (srcNote) lines.push("", srcNote);

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: {
      verdict,
      target: target
        ? {
            case_number: itemCaseNumber(target),
            court: itemCourtName(target),
            judgment_date: target.judgmentDate ?? null,
            saos_id: target.id,
            url: `https://www.saos.org.pl/judgments/${target.id}`,
          }
        : null,
      total_citing_found: citing.length,
      total_citing_in_saos: totalCitingRaw,
      scanned_deep: scannedDeep,
      hits,
      disclaimer: CITE_CHECK_DISCLAIMER,
      source: combineSources(sources),
      citations: buildSearchCitations({ items: citing.slice(0, CITE_DISPLAY_LIMIT) }),
    },
  };
}

// ---------------------------------------------------------------------------
// Instructions (procedural orchestration) - wstrzykiwane przez Server do
// system promptu klienta MCP. LLM widzi PRZED pierwszym tool call.
// Drift test (test/drift.mjs) failuje jesli tool wymieniony nie jest w
// TOOLS, albo ErrorCode w typie TS nie udokumentowany w INSTRUCTIONS.
// Pattern z dograh-hq/dograh v1.31.0 (BSD-2), zaadaptowany na MateMatic.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `Ten serwer MCP udostepnia orzeczenia polskich sadow z bazy SAOS (saos.org.pl) - sady powszechne, Sad Najwyzszy, Trybunal Konstytucyjny, KIO. Odpowiedzi z lokalnej kopii oficjalnego dumpu SAOS (aktualizowanej codziennie), z API SAOS jako zapasem i weryfikacja; bez modyfikacji tresci - dane primary (Fundacja ePanstwo).

## Kolejnosc wywolan

### Szukanie orzecznictwa
1. \`search_by_case\` - jesli uzytkownik podal sygnature akt (np. "I ACa 772/13", "IV CSK 123/15") - to skrot, najszybciej.
2. \`search\` - szerokie szukanie po tresci, podstawie prawnej, sedzim, dacie, typie sadu. Zwraca paginowane wyniki (default 10/strona, max 100).
3. \`get_judgment\` - pelne orzeczenie po ID numerycznym z wynikow search. Zwraca metadata + pierwsze 2000 znakow tresci.

### Citator - czy wyrok zyje
4. \`saos_cite_check\` - podaj sygnature, dostaniesz: (a) pozniejsze orzeczenia cytujace ja (pelnotekstowo), (b) skan uzasadnien pod frazy przelamania linii orzeczniczej W OKNIE wokol sygnatury, (c) werdykt: \`przelamanie_wykryte\` / \`uchwala_skladu_powiekszonego\` / \`nadal_cytowany\` / \`brak_cytowan_w_saos\`. Uzywaj PRZED zacytowaniem orzeczenia jako aktualnego. Werdykt to heurystyka - przy \`przelamanie_wykryte\` ZAWSZE zweryfikuj pelny tekst trafienia przez \`get_judgment\`. Brak trafien NIE potwierdza aktualnosci (pokrycie SAOS nierowne).

## Twarde ograniczenia

- **Pokrycie nierowne** - sady powszechne dobrze, SN/TK/KIO obecne. **Sady administracyjne (WSA/NSA) NIE sa w SAOS** - dla nich uzyj mcp-nsa (orzeczenia.nsa.gov.pl).
- **Daty znieksztalcone przez OCR** - mozesz zobaczyc "rok 3013" lub inne nielogiczne. Domyslny upper bound to dzisiaj, zeby OCR-mangled daty nie zalaly DESC sort. Weryfikuj sygnature i date w zrodle (saos.org.pl/judgments/{id}).
- **Bez modyfikacji tresci** - zwracamy verbatim z SAOS. NIE prosc o parafraze "lepszym jezykiem" - to wartosc dowodowa.
- **Zrodlo danych** - lokalna kopia dumpu SAOS (pelna baza, aktualizacja przyrostowa raz dziennie - orzeczenia opublikowane w SAOS dzisiaj moga pojawic sie jutro). Gdy lokalnie brak wyniku, serwer pyta API SAOS; wynik z API ma \`structuredContent.source\` = \`saos_api_fallback\` i adnotacje w tekscie. NIE polegaj na ciaglosci sesji.
- **\`structuredContent.citations\`** zawsze wypelnione: title, url (saos.org.pl/judgments/{id}), case_number, court, judgment_date, snippet. Cytuj te citations w odpowiedzi koncowej.

## Iteracja po bledach

Tool zwraca \`isError: true\` + tekst z prefixem \`[code]\`. Typowe kody:
- \`missing_arg\` - brakujacy wymagany parametr (np. id w get_judgment, caseNumber w search_by_case). Przeczytaj inputSchema.
- \`not_found\` - orzeczenie/sygnatura nie ma w SAOS. Sprobuj szerszej daty / innej sygnatury, lub czy to nie WSA/NSA (osobny konektor).
- \`upstream_error\` - blad komunikacji z API SAOS (HTTP 5xx, timeout 40s). Retry raz przed surface do uzytkownika.
- \`invalid_court_type\` - klient podal \`ADMINISTRATIVE\` lub inny niedozwolony typ. Dozwolone: COMMON, SUPREME, CONSTITUTIONAL_TRIBUNAL, NATIONAL_APPEAL_CHAMBER.

## Styl odpowiedzi

- Cytuj sygnature w pelnej formie z sadem: "I ACa 772/13 (SA Warszawa, 2013-09-15)".
- Przy linii orzeczniczej (\`search\` z legalBase) sortuj wyniki chronologicznie i komentuj zmiany linii.
- NIE wymyslaj sygnatur ani sklad ow sedziowskich - kazda informacja z \`structuredContent.citations\`.
- Disclaimer SAOS (pokrycie nierowne, OCR daty, brak admin courts) zostaw w odpowiedzi przy szerokim szukaniu.`;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true, // upstream API moze zwracac inne wyniki w czasie
} as const;

const TOOLS = [
  {
    name: "search",
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Przeszukuje baze orzeczen sadow polskich w SAOS (System Analizy Orzeczen Sadowych). " +
      "Pokrycie obejmuje takze orzeczenia biezace (lata 2024-2026 sa dobrze reprezentowane), " +
      "ale jest nierowne wg typu sadu. Sady administracyjne (WSA/NSA) NIE sa indeksowane. " +
      "Daty bywaja znieksztalcone przez OCR - weryfikuj sygnature i date w zrodle. " +
      "Przydatny do: analizy linii orzeczniczej, precedensow, " +
      "wyszukiwania po tresci / sygnatuze / sedzim / podstawie prawnej. " +
      "Bledy: `invalid_court_type` (zly enum), `upstream_error` (HTTP/timeout API).",
    inputSchema: {
      type: "object",
      properties: {
        all: {
          type: "string",
          description: "Wyszukiwanie pelnotekstowe - slowo lub fraza w tresci orzeczenia.",
        },
        caseNumber: {
          type: "string",
          description: "Sygnatura akt, np. 'I ACa 772/13' lub 'IV CSK 123/15'.",
        },
        courtType: {
          type: "string",
          enum: ["COMMON", "SUPREME", "CONSTITUTIONAL_TRIBUNAL", "NATIONAL_APPEAL_CHAMBER"],
          description:
            "Typ sadu: COMMON=sady powszechne, SUPREME=Sad Najwyzszy, " +
            "CONSTITUTIONAL_TRIBUNAL=Trybunal Konstytucyjny, " +
            "NATIONAL_APPEAL_CHAMBER=Krajowa Izba Odwolawcza (KIO). " +
            "NIE uzywaj ADMINISTRATIVE - sady admin nie sa w SAOS.",
        },
        judgeName: {
          type: "string",
          description: "Nazwisko sedziego, np. 'Kowalski'.",
        },
        referencedRegulation: {
          type: "string",
          description: "Przywolany akt prawny, np. 'ustawa o ochronie danych osobowych'.",
        },
        legalBase: {
          type: "string",
          description: "Podstawa prawna, np. 'art. 415 kc' lub 'art. 6 RODO'.",
        },
        dateFrom: {
          type: "string",
          description: "Data orzeczenia od (format YYYY-MM-DD), np. '2015-01-01'.",
        },
        dateTo: {
          type: "string",
          description: "Data orzeczenia do (format YYYY-MM-DD), np. '2016-12-31'.",
        },
        pageSize: {
          type: "number",
          description: "Liczba wynikow na strone (min 10, max 100). Domyslnie 10.",
          minimum: 10,
          maximum: 100,
        },
        pageNumber: {
          type: "number",
          description: "Numer strony (od 0). Do paginacji wynikow.",
          minimum: 0,
        },
      },
      required: [],
    },
  },
  {
    name: "get_judgment",
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Pobiera pelne orzeczenie z SAOS po jego numerycznym ID. " +
      "Zwraca metadane (sygnatura, sad, data, sklad, podstawy prawne), " +
      "streszczenie (jesli dostepne) oraz pierwsze 2000 znakow tresci. " +
      "ID orzeczenia pochodzi z wynikow narzedzia 'search' lub 'search_by_case'. " +
      "Bledy: `missing_arg` (brak id), `not_found` (id poza baza), `upstream_error`.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: ["string", "number"],
          description: "Numeryczne ID orzeczenia w bazie SAOS, np. 352475 lub '31345'.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "search_by_case",
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Skrot: szuka orzeczenia po sygnaturze akt (np. 'I ACa 772/13', 'IV CSK 123/15', 'KIO/UZP 100/12'). " +
      "Odpowiednik search z parametrem caseNumber. " +
      "Jesli sygnatura nie znajdzie sie w SAOS, sprawa moze byc z sadu administracyjnego " +
      "(WSA/NSA - nieindeksowane) lub jeszcze nieopublikowana w bazie. " +
      "Bledy: `missing_arg` (brak caseNumber), `upstream_error`.",
    inputSchema: {
      type: "object",
      properties: {
        caseNumber: {
          type: "string",
          description: "Sygnatura akt, np. 'I ACa 772/13'.",
        },
      },
      required: ["caseNumber"],
    },
  },
  {
    name: "saos_cite_check",
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      "Citator 'czy wyrok zyje': dla podanej sygnatury szuka POZNIEJSZYCH orzeczen, " +
      "ktore ja cytuja (pelnotekstowo w SAOS), i skanuje ich uzasadnienia pod frazy " +
      "przelamania linii orzeczniczej (np. 'odstepuje od pogladu wyrazonego', " +
      "'nie podziela pogladu', 'traci moc uchwala', 'uchwala skladu siedmiu sedziow') " +
      "w oknie ~500 znakow wokol wystapienia sygnatury. " +
      "Werdykt: przelamanie_wykryte / uchwala_skladu_powiekszonego / nadal_cytowany / " +
      "brak_cytowan_w_saos. To heurystyka - kazde trafienie ma fragment tekstu do " +
      "recznej weryfikacji, a brak trafien NIE potwierdza aktualnosci orzeczenia. " +
      "Bledy: `missing_arg` (nieczytelna sygnatura), `invalid_court_type`, `upstream_error`.",
    inputSchema: {
      type: "object",
      properties: {
        caseNumber: {
          type: "string",
          description:
            "Sygnatura akt orzeczenia do sprawdzenia, np. 'III CZP 6/21'. " +
            "Moze byc czescia zdania ('uchwala SN z 7.05.2021 r., III CZP 6/21').",
        },
        courtType: {
          type: "string",
          enum: ["COMMON", "SUPREME", "CONSTITUTIONAL_TRIBUNAL", "NATIONAL_APPEAL_CHAMBER"],
          description:
            "Opcjonalnie: typ sadu orzeczenia badanego - sygnatury powtarzaja sie " +
            "miedzy sadami, to doprecyzowuje ktore orzeczenie sprawdzamy.",
        },
        maxScan: {
          type: "number",
          description:
            "Ile cytujacych orzeczen przeskanowac w pelnym tekscie (1-20, domyslnie 8). " +
            "Priorytet: SN > uchwaly > najnowsze.",
          minimum: 1,
          maximum: 20,
        },
        deepScan: {
          type: "boolean",
          description:
            "Czy pobierac pelne teksty cytujacych orzeczen (domyslnie true). " +
            "false = tylko szybki skan snippetow z wyszukiwarki.",
        },
      },
      required: ["caseNumber"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

// Strukturalne kody bledow - drift test asercja ze kazdy tu uzyty jest
// udokumentowany w INSTRUCTIONS i kazdy w errorResult() istnieje w typie.
type ErrorCode =
  | "missing_arg"
  | "not_found"
  | "upstream_error"
  | "invalid_court_type";

function errorResult(text: string, code: ErrorCode) {
  return {
    content: [{ type: "text" as const, text: `[${code}] ${text}` }],
    structuredContent: { error_code: code },
    isError: true,
  };
}

const VALID_COURT_TYPES = new Set([
  "COMMON",
  "SUPREME",
  "CONSTITUTIONAL_TRIBUNAL",
  "NATIONAL_APPEAL_CHAMBER",
]);

function createServer(): Server {
const server = new Server(
  { name: "mcp-saos", version: "1.3.0" }, // keep in sync with package.json "version"
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "search": {
        if (a.courtType && !VALID_COURT_TYPES.has(String(a.courtType))) {
          return errorResult(
            `courtType '${a.courtType}' niedozwolony. Uzyj: ${[...VALID_COURT_TYPES].join(", ")}. NIE uzywaj ADMINISTRATIVE (sady admin nie sa w SAOS - uzyj mcp-nsa).`,
            "invalid_court_type"
          );
        }
        const { data: raw, source } = await searchJudgments({
          all: a.all as string | undefined,
          caseNumber: a.caseNumber as string | undefined,
          courtType: a.courtType as string | undefined,
          judgeName: a.judgeName as string | undefined,
          referencedRegulation: a.referencedRegulation as string | undefined,
          legalBase: a.legalBase as string | undefined,
          judgmentDateFrom: a.dateFrom as string | undefined,
          judgmentDateTo: a.dateTo as string | undefined,
          pageSize: a.pageSize as number | undefined,
          pageNumber: a.pageNumber as number | undefined,
        }, "search");
        return {
          content: [{ type: "text", text: withSourceNote(formatSearchResults(raw), source) }],
          structuredContent: { citations: buildSearchCitations(raw), source },
        };
      }

      case "get_judgment": {
        if (!a.id) {
          return errorResult("parametr 'id' jest wymagany.", "missing_arg");
        }
        const { data: raw, source } = await getJudgment(a.id as string | number, "get_judgment");
        if (!raw || (typeof raw === "object" && Object.keys(raw).length === 0)) {
          return errorResult(
            `Orzeczenie ID ${a.id} nie znalezione w SAOS. Sprawdz ID przez 'search' / 'search_by_case' lub czy nie jest to sad administracyjny (WSA/NSA - uzyj mcp-nsa).`,
            "not_found"
          );
        }
        const citation = buildJudgmentCitation(raw);
        return {
          content: [{ type: "text", text: withSourceNote(formatJudgment(raw), source) }],
          structuredContent: { citations: citation ? [citation] : [], source },
        };
      }

      case "search_by_case": {
        if (!a.caseNumber) {
          return errorResult("parametr 'caseNumber' jest wymagany.", "missing_arg");
        }
        const { data: raw, source } = await searchJudgments({
          caseNumber: a.caseNumber as string,
          pageSize: PAGE_SIZE_DEFAULT,
        }, "search_by_case");
        return {
          content: [{ type: "text", text: withSourceNote(formatSearchResults(raw), source) }],
          structuredContent: { citations: buildSearchCitations(raw), source },
        };
      }

      case "saos_cite_check": {
        if (!a.caseNumber) {
          return errorResult("parametr 'caseNumber' jest wymagany.", "missing_arg");
        }
        return await runCiteCheck(a);
      }

      default:
        return errorResult(`Nieznane narzedzie: ${name}`, "missing_arg");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(
      `Blad komunikacji z API SAOS: ${msg}. Sprawdz polaczenie lub sprobuj ponownie.`,
      "upstream_error"
    );
  }
});

return server;
}

// ---------------------------------------------------------------------------
// Dump sync scheduler (HTTP mode, or SAOS_SYNC=1): runs dist/sync.js as a child
// process - first the resumable full download, then once a day (SAOS_SYNC_AT,
// default 03:30 container time) the incremental update.
// ---------------------------------------------------------------------------

let syncRunning = false;
let lastSyncAttempt = 0;

function runSync(): void {
  syncRunning = true;
  lastSyncAttempt = Date.now();
  const child = spawn(process.execPath, [join(__dirname, "sync.js")], { stdio: "inherit" });
  child.on("exit", (code) => {
    syncRunning = false;
    process.stderr.write(`mcp-saos: sync finished with code ${code}\n`);
  });
}

function syncDue(): boolean {
  if (syncRunning) return false;
  const store = localStore();
  // No mirror yet / full download unfinished: (re)start, retry 15 min after a failure.
  if (!store || !store.isReady()) return Date.now() - lastSyncAttempt > 15 * 60 * 1000;
  const [h, m] = (process.env.SAOS_SYNC_AT ?? "03:30").split(":").map(Number);
  const now = new Date();
  const dueAt = new Date(now);
  dueAt.setHours(h, m, 0, 0);
  if (now < dueAt) dueAt.setDate(dueAt.getDate() - 1);
  const last = Date.parse(store.getState("last_sync") ?? "") || 0;
  return last < dueAt.getTime() && Date.now() - lastSyncAttempt > 60 * 60 * 1000;
}

function startScheduler(): void {
  const tick = () => {
    if (syncDue()) runSync();
  };
  tick();
  setInterval(tick, 60 * 1000).unref();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function startHttp(): Promise<void> {
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const port = Number(process.env.PORT ?? 8000);
  const mcpPath = process.env.MCP_HTTP_PATH ?? "/mcp";

  const http = createHttpServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (path === "/status") {
      const store = localStore();
      sendJson(res, 200, store ? { ...store.stats(), sync_running: syncRunning } : { local: false, sync_running: syncRunning });
      return;
    }
    if (path !== mcpPath) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no SSE stream (GET) and no sessions to delete.
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { Allow: "POST" });
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      const body = await readBody(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
      process.stderr.write(`mcp-saos: request failed: ${String(err)}\n`);
    }
  });
  http.listen(port, "0.0.0.0", () => {
    process.stderr.write(`mcp-saos server started (Streamable HTTP on :${port}${mcpPath})\n`);
  });
}

async function main() {
  if (process.env.MCP_TRANSPORT === "http") {
    await startHttp();
  } else {
    const transport = new StdioServerTransport();
    await createServer().connect(transport);
    // Log to stderr only - stdout is reserved for MCP JSON-RPC protocol
    process.stderr.write("mcp-saos server started (stdio transport)\n");
  }
  if (process.env.MCP_TRANSPORT === "http" ? process.env.SAOS_SYNC !== "0" : process.env.SAOS_SYNC === "1") {
    startScheduler();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
