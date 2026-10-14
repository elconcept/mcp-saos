// Unit tests for the cite-check logic (parser / window scan / phrase patterns).
//
// Fixture provenance: test/fixtures/odstapienie-i-c-3346-24.txt is a verbatim
// fragment of SAOS judgment id 543228 (I C 3346/24, 2025-03-05) fetched from
// https://www.saos.org.pl/api/judgments/543228 on 2026-07-13. It is real,
// public case-law data: a district court expressly departing from the view
// expressed in Supreme Court resolution III CZP 6/21.
//
// Phrase exemplars below are verbatim fragments returned by live SAOS API
// queries on 2026-07-13 (see docs/CITE-CHECK.md for query evidence).
//
// Run: npm run test:unit   (node --test, no network required)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseCaseNumber,
  buildCaseNumberRegex,
  normalizeText,
  scanWindows,
  computeVerdict,
  STRONG_PATTERNS,
  CAUTION_PATTERNS,
  ALL_PATTERNS,
} from "../dist/cite-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  join(__dirname, "fixtures", "odstapienie-i-c-3346-24.txt"),
  "utf-8"
);

// ---------------------------------------------------------------------------
// parseCaseNumber
// ---------------------------------------------------------------------------

test("parseCaseNumber: bare signature", () => {
  assert.equal(parseCaseNumber("III CZP 6/21"), "III CZP 6/21");
});

test("parseCaseNumber: signature inside a sentence", () => {
  assert.equal(
    parseCaseNumber("uchwala SN z 7.05.2021 r., III CZP 6/21, dot. klauzul"),
    "III CZP 6/21"
  );
});

test("parseCaseNumber: strips 'sygn. akt' prefix", () => {
  assert.equal(parseCaseNumber("sygn. akt I ACa 772/13"), "I ACa 772/13");
});

test("parseCaseNumber: Constitutional Tribunal single-letter symbol", () => {
  assert.equal(parseCaseNumber("K 7/94"), "K 7/94");
});

test("parseCaseNumber: KIO slashed division symbol", () => {
  assert.equal(parseCaseNumber("KIO/UZP 100/12"), "KIO/UZP 100/12");
});

test("parseCaseNumber: no signature returns null", () => {
  assert.equal(parseCaseNumber("zupelnie zwykle zdanie bez sygnatury"), null);
});

// ---------------------------------------------------------------------------
// buildCaseNumberRegex - word boundary rules
// (reference_regex_skroty_prawne_granice_slowa: short legal tokens without
// boundaries produce mass noise)
// ---------------------------------------------------------------------------

test("case regex: matches the signature in running text", () => {
  const re = buildCaseNumberRegex("III CZP 6/21");
  assert.match("wyrazonego w uchwale III CZP 6/21 co do kryteriow", re);
});

test("case regex: tolerates extra whitespace and spaced slash", () => {
  const re = buildCaseNumberRegex("III CZP 6/21");
  assert.match("III  CZP 6 / 21", re);
  assert.match("III CZP 6/21", re);
});

test("case regex: does NOT match a longer case number (digit suffix)", () => {
  const re = buildCaseNumberRegex("III CZP 6/21");
  assert.doesNotMatch("w sprawie III CZP 6/215 orzeczono", re);
});

test("case regex: does NOT match inside a different roman prefix", () => {
  const re = buildCaseNumberRegex("III CZP 6/21");
  assert.doesNotMatch("w sprawie XIII CZP 6/21 orzeczono", re);
});

// ---------------------------------------------------------------------------
// scanWindows - anchoring to the signature
// ---------------------------------------------------------------------------

test("scanWindows: detects strong signal in the real I C 3346/24 fragment", () => {
  const hits = scanWindows(FIXTURE, "III CZP 6/21");
  const strong = hits.filter((h) => h.severity === "strong");
  assert.ok(strong.length >= 1, "expected a strong hit");
  assert.equal(strong[0].label, "odstapienie_od_pogladu");
  assert.match(strong[0].phrase, /odstąpił od poglądu/iu);
  assert.ok(strong[0].fragment.includes("III CZP 6/21"));
});

test("scanWindows: phrase outside the 500-char window is ignored", () => {
  const filler = "tekst neutralny ".repeat(60); // ~960 chars, no signals
  const text = `Sad powolal uchwale III CZP 6/21. ${filler} Sad odstepuje od pogladu wyrazonego w innej sprawie.`;
  assert.equal(scanWindows(text, "III CZP 6/21").length, 0);
});

test("scanWindows: phrase near a DIFFERENT signature is not attributed", () => {
  const text =
    "Sad odstapil od pogladu wyrazonego w wyroku II CSK 456/07 i podtrzymal linie.";
  assert.equal(scanWindows(text, "III CZP 6/21").length, 0);
});

test("scanWindows: no anchors means no hits", () => {
  assert.equal(scanWindows("Sad nie podziela pogladu skarzacego.", "III CZP 6/21").length, 0);
});

test("scanWindows: negation guard rejects 'Nie jest to poglad odosobniony'", () => {
  const text = "Jak wskazano w III CZP 6/21, nie jest to pogląd odosobniony w orzecznictwie.";
  const hits = scanWindows(text, "III CZP 6/21");
  assert.equal(hits.filter((h) => h.label === "poglad_odosobniony").length, 0);
});

test("scanWindows: non-negated 'poglad odosobniony' is a hit", () => {
  const text = "Stanowisko wyrazone w III CZP 6/21 to obecnie pogląd odosobniony.";
  const hits = scanWindows(text, "III CZP 6/21");
  assert.equal(hits.filter((h) => h.label === "poglad_odosobniony").length, 1);
});

test("scanWindows: caution signal (uchwala skladu siedmiu sedziow)", () => {
  const text =
    "Poglad z III CZP 6/21 nalezy odczytywac w swietle pozniejszej uchwały składu siedmiu sędziów Sądu Najwyższego.";
  const hits = scanWindows(text, "III CZP 6/21");
  assert.ok(hits.some((h) => h.severity === "caution" && h.label === "uchwala_skladu_siedmiu"));
});

test("scanWindows: fragment is bounded to about +-200 chars", () => {
  const hits = scanWindows(FIXTURE, "III CZP 6/21");
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.ok(h.fragment.length <= 400 + h.phrase.length + 10);
  }
});

// ---------------------------------------------------------------------------
// Phrase pattern table - every pattern must match its live-verified exemplar.
// Exemplars are verbatim fragments from SAOS judgments (query evidence in
// docs/CITE-CHECK.md).
// ---------------------------------------------------------------------------

const EXEMPLARS = [
  // [label, verbatim fragment from a real judgment]
  ["odstapienie_od_pogladu", "Sąd odstępuje od poglądu wyrażonego w uzasadnieniu wyroku częściowego"],
  ["odstapienie_od_pogladu", "nie ma podstaw, aby odstąpić od poglądu wyrażonego przez"],
  ["odstapienie_od_pogladu", "Sąd odstąpił od poglądu wyrażonego we wskazanej wyżej uchwale"],
  ["odstapienie_od_pogladu", "uzasadniają odstąpienie od dotychczasowej linii orzeczniczej"],
  ["nie_podziela_pogladu", "nie podziela poglądu zaprezentowanego w wyroku Sądu Najwyższego"],
  ["nie_podziela_pogladu", "Sąd nie podziela stanowiska organu rentowego"],
  ["utrata_aktualnosci", "pogląd ten utracił aktualność , jako że sformułowany został"],
  ["zdezaktualizowanie", "wobec innych ustaleń faktycznych sądu odwoławczego, obecnie się zdezaktualizowały"],
  ["utrata_mocy_uchwaly", "z chwilą podjęcia niniejszej uchwały traci moc uchwała nr"],
  ["brak_aprobaty", "nie zasługuje na aprobatę pogląd uznający dopuszczalność"],
  ["rozbieznosc_orzecznicza", "Sąd Najwyższy uznał, odmiennie niż w uchwale z dnia 15 listopada 2001 r."],
  ["rozbieznosc_orzecznicza", "wadliwie przyjął – odmiennie niż w wyroku z dnia 18 lutego 2021 r."],
  ["poglad_odosobniony", "Nie jest to pogląd odosobniony ."],
  ["uchwala_skladu_siedmiu", "jak stanowi uchwała Składu Siedmiu Sędziów Sądu Najwyższego"],
  ["uchwala_pelnego_skladu", "( uchwała pełnego składu Izby Cywilnej Sądu Najwyższego z dnia 25"],
  ["zagadnienie_prawne", "wprawdzie zagadnienie prawne przedstawione do rozstrzygnięcia"],
  ["zagadnienie_prawne", "może przedstawić zagadnienie prawne do rozstrzygnięcia składowi siedmiu sędziów"],
];

for (const [label, exemplar] of EXEMPLARS) {
  test(`pattern '${label}' matches live exemplar: "${exemplar.slice(0, 50)}..."`, () => {
    const pattern = ALL_PATTERNS.find((p) => p.label === label);
    assert.ok(pattern, `pattern ${label} exists`);
    assert.match(normalizeText(exemplar), new RegExp(pattern.re.source, pattern.re.flags));
  });
}

test("every pattern has a live-verified exemplar in this table", () => {
  const covered = new Set(EXEMPLARS.map(([label]) => label));
  for (const p of ALL_PATTERNS) {
    assert.ok(covered.has(p.label), `missing exemplar for pattern '${p.label}'`);
  }
});

test("pattern sets are disjoint and labelled consistently", () => {
  for (const p of STRONG_PATTERNS) assert.equal(p.severity, "strong");
  for (const p of CAUTION_PATTERNS) assert.equal(p.severity, "caution");
  const labels = ALL_PATTERNS.map((p) => p.label);
  assert.equal(new Set(labels).size, labels.length, "duplicate labels");
});

// ---------------------------------------------------------------------------
// computeVerdict
// ---------------------------------------------------------------------------

test("verdict: strong hit wins", () => {
  const v = computeVerdict(5, [
    { label: "x", severity: "caution", phrase: "", fragment: "", index: 0 },
    { label: "y", severity: "strong", phrase: "", fragment: "", index: 1 },
  ]);
  assert.equal(v, "przelamanie_wykryte");
});

test("verdict: caution only", () => {
  const v = computeVerdict(5, [
    { label: "x", severity: "caution", phrase: "", fragment: "", index: 0 },
  ]);
  assert.equal(v, "uchwala_skladu_powiekszonego");
});

test("verdict: citations without signals", () => {
  assert.equal(computeVerdict(3, []), "nadal_cytowany");
});

test("verdict: nothing found", () => {
  assert.equal(computeVerdict(0, []), "brak_cytowan_w_saos");
});
