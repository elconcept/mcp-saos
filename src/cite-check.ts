/**
 * cite-check - logika citatora "czy wyrok zyje" dla polskiego orzecznictwa.
 *
 * Wzorzec: cite_check z chrisryugj/korean-law-mcp (MIT) - koreanski Shepard's
 * Citator na bazie API legislation.go.kr. Tu adaptacja na SAOS: pelnotekstowe
 * wyszukiwanie pozniejszych orzeczen cytujacych sygnature + skan uzasadnien
 * pod frazy przelamania linii orzeczniczej W OKNIE wokol wystapienia sygnatury
 * (fraza musi dotyczyc TEJ sygnatury, nie calego dokumentu).
 *
 * Kazda fraza na liscie zostala zweryfikowana zywym zapytaniem do SAOS API
 * (2026-07-13) - realnie wystepuje w uzasadnieniach. Dowody: docs/CITE-CHECK.md.
 *
 * Ten modul jest czysty (bez I/O) - orkiestracja i HTTP w src/index.ts.
 */

// ---------------------------------------------------------------------------
// Frazy przelamania linii orzeczniczej
// ---------------------------------------------------------------------------

export type Severity = "strong" | "caution";

export interface PhrasePattern {
  /** Regex dopasowujacy fraze wraz z odmianami fleksyjnymi. */
  re: RegExp;
  /** Stala etykieta trafienia (bez diakrytykow, snake_case). */
  label: string;
  severity: Severity;
  /**
   * Guard negacji: odrzuc trafienie, jesli bezposrednio przed nim stoi
   * negacja ("Nie jest to poglad odosobniony" = poglad UGRUNTOWANY).
   */
  negationGuard?: boolean;
}

// Klasa polskich liter do dopasowania koncowek fleksyjnych.
const PL = "a-ząćęłńóśźż";

/**
 * STRONG - jezykowe sygnaly odstapienia od pogladu / przelamania linii.
 * Kazdy wzorzec ma zywy dowod w SAOS (liczba trafien + przykladowa sygnatura
 * w docs/CITE-CHECK.md).
 */
export const STRONG_PATTERNS: PhrasePattern[] = [
  {
    // "odstepuje od pogladu wyrazonego", "odstapil od pogladu", "odstapienie
    // od dotychczasowej linii orzeczniczej", "odstapic od wykladni"...
    re: new RegExp(
      `odst(?:[ęe]puj[${PL}]*|[ąa]pi[${PL}]*)\\s+od\\s+` +
        `(?:pogl[ąa]d[${PL}]*|stanowisk[${PL}]*|wyk[łl]adni|dotychczasow[${PL}]*|linii)`,
      "iu"
    ),
    label: "odstapienie_od_pogladu",
    severity: "strong",
  },
  {
    // "nie podziela pogladu", "nie podzielil stanowiska wyrazonego w"
    re: new RegExp(
      `nie\\s+podziela(?:j[ąa]c[${PL}]*|[łl][${PL}]*|my)?\\s+(?:pogl[ąa]d|stanowisk)[${PL}]*`,
      "iu"
    ),
    label: "nie_podziela_pogladu",
    severity: "strong",
  },
  {
    // "poglad ten utracil aktualnosc", "utracily aktualnosc"
    re: new RegExp(`utraci[${PL}]*\\s+(?:na\\s+)?aktualno[${PL}]*`, "iu"),
    label: "utrata_aktualnosci",
    severity: "strong",
  },
  {
    // "zdezaktualizowal sie", "zdezaktualizowane", "zdezaktualizowaly"
    re: /zdezaktualizowa/iu,
    label: "zdezaktualizowanie",
    severity: "strong",
  },
  {
    // "traci moc uchwala..." (formula derogacyjna)
    re: new RegExp(`traci\\s+moc\\s+uchwa[łl][${PL}]*`, "iu"),
    label: "utrata_mocy_uchwaly",
    severity: "strong",
  },
  {
    // "nie zasluguje na aprobate poglad..."
    re: /nie\s+zas[łl]uguje\s+na\s+aprobat[ęe]/iu,
    label: "brak_aprobaty",
    severity: "strong",
  },
  {
    // "odmiennie niz w wyroku / uchwale / postanowieniu z dnia..."
    re: /odmiennie\s+ni[żz]\s+w\s+(?:wyroku|uchwale|postanowieniu)/iu,
    label: "rozbieznosc_orzecznicza",
    severity: "strong",
  },
  {
    // "poglad odosobniony" - z guardem negacji ("NIE jest to poglad
    // odosobniony" znaczy odwrotnosc: poglad ugruntowany).
    re: /pogl[ąa]d\s+odosobniony/iu,
    label: "poglad_odosobniony",
    severity: "strong",
    negationGuard: true,
  },
];

/**
 * CAUTION - sygnaly istnienia pozniejszej uchwaly skladu powiekszonego lub
 * zawislego zagadnienia prawnego. Same w sobie nie przesadzaja o przelamaniu,
 * ale wymagaja weryfikacji pelnego tekstu.
 */
export const CAUTION_PATTERNS: PhrasePattern[] = [
  {
    re: new RegExp(
      `uchwa[łl][${PL}]*\\s+sk[łl]adu\\s+siedmiu\\s+s[ęe]dzi[óo]w`,
      "iu"
    ),
    label: "uchwala_skladu_siedmiu",
    severity: "caution",
  },
  {
    re: new RegExp(`uchwa[łl][${PL}]*\\s+pe[łl]nego\\s+sk[łl]adu`, "iu"),
    label: "uchwala_pelnego_skladu",
    severity: "caution",
  },
  {
    // "zagadnienie prawne przedstawione do rozstrzygniecia" /
    // "przedstawic zagadnienie prawne (do rozstrzygniecia skladowi...)"
    re: new RegExp(
      `zagadnieni[ea][${PL}]*\\s+prawn[${PL}]*\\s+przedstawion[${PL}]*` +
        `|przedstawi[${PL}]*\\s+zagadnieni[ea]\\s+prawn[${PL}]*`,
      "iu"
    ),
    label: "zagadnienie_prawne",
    severity: "caution",
  },
];

export const ALL_PATTERNS: PhrasePattern[] = [...STRONG_PATTERNS, ...CAUTION_PATTERNS];

// ---------------------------------------------------------------------------
// Parser sygnatury akt
// ---------------------------------------------------------------------------

// Duze polskie litery do tokenow wydzialowych (ACa, CSK, CZP, Ua, KIO...).
const UP = "A-ZĄĆĘŁŃÓŚŹŻ";

/**
 * Sygnatura akt: opcjonalny numer rzymski + max 2 krotkie tokeny wydzialowe
 * (w tym warianty z ukosnikiem jak "KIO/UZP") + numer/rok.
 * Tokeny ograniczone do 5 znakow - dluzsze slowa ("Najwyzszego") odpadaja.
 * Regula granic slowa: numer nie moze byc prefiksem dluzszej liczby
 * (por. reference_regex_skroty_prawne_granice_slowa).
 */
const CASE_NO_RE = new RegExp(
  `(?:\\b[IVXLCDM]+\\s+)?` +
    `(?:[${UP}][${UP}${PL}]{0,4}(?:\\/[${UP}][${UP}${PL}]{0,4})?\\.?\\s+){0,2}` +
    `\\d{1,6}\\s*\\/\\s*\\d{2,4}(?!\\d)`,
  "gu"
);

/**
 * Wyciaga pierwsza sygnature akt z dowolnego tekstu (takze z pelnego zdania
 * typu "wyrok SN z 7.05.2021 r., III CZP 6/21"). Zwraca znormalizowana
 * (pojedyncze spacje, bez spacji wokol ukosnika) lub null.
 */
export function parseCaseNumber(input: string): string | null {
  const cleaned = input
    .replace(/sygn(?:atura)?\.?\s*(?:akt)?:?/giu, " ")
    .replace(/["'„”’]/gu, " ");
  CASE_NO_RE.lastIndex = 0;
  const m = CASE_NO_RE.exec(cleaned);
  if (!m) return null;
  return m[0].replace(/\s*\/\s*/gu, "/").replace(/\s+/gu, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex dopasowujacy sygnature w tekscie orzeczenia: elastyczne odstepy
 * (spacje, nbsp, wielokrotne), opcjonalne spacje wokol ukosnika, twarde
 * granice (przed: nie-znak-slowny, po: nie-cyfra), zeby "III CZP 6/21"
 * nie lapalo "III CZP 6/215" ani fragmentu "XIII CZP 6/21".
 */
export function buildCaseNumberRegex(caseNumber: string): RegExp {
  const normalized = caseNumber.replace(/\s*\/\s*/gu, "/").replace(/\s+/gu, " ").trim();
  const body = normalized
    .split(" ")
    .map((part) => escapeRe(part).replace(/\//g, "\\s*\\/\\s*"))
    .join("[\\s\\u00a0]+");
  // Bez flagi "g" - regexy z "g" sa stanowe (lastIndex) i psuja powtorne
  // .test()/.exec(); iteracja globalna dodaje "g" lokalnie (scanWindows).
  return new RegExp(`(?<![\\w\\/])${body}(?!\\d)`, "iu");
}

// ---------------------------------------------------------------------------
// Skan okna wokol sygnatury
// ---------------------------------------------------------------------------

export interface ScanHit {
  label: string;
  severity: Severity;
  /** Doslownie dopasowana fraza z tekstu. */
  phrase: string;
  /** Fragment +-fragmentRadius znakow wokol frazy - grounding dla czlowieka. */
  fragment: string;
  /** Pozycja frazy w przeskanowanym tekscie. */
  index: number;
}

/** Ile znakow przed trafieniem sprawdzamy pod negacje ("nie jest to..."). */
const NEGATION_LOOKBEHIND = 30;
const NEGATION_RE = /\bnie\s+(?:jest|by[łl][ao]?|wydaje\s+si[ęe])\s*(?:to\s+)?(?:wcale\s+)?$/iu;

export const DEFAULT_WINDOW = 500;
export const DEFAULT_FRAGMENT_RADIUS = 200;

/** Usuwa HTML i normalizuje biale znaki - tekst gotowy do skanu. */
export function normalizeText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Skanuje tekst orzeczenia pod frazy przelamania W OKNIE +-window znakow
 * wokol kazdego wystapienia sygnatury. Fraza poza oknem = nie dotyczy tej
 * sygnatury = brak trafienia. Zwraca trafienia zdeduplikowane po
 * (label, index).
 */
export function scanWindows(
  text: string,
  caseNumber: string,
  window: number = DEFAULT_WINDOW,
  fragmentRadius: number = DEFAULT_FRAGMENT_RADIUS
): ScanHit[] {
  const clean = normalizeText(text);
  const base = buildCaseNumberRegex(caseNumber);
  const caseRe = new RegExp(base.source, base.flags + "g");
  const anchors: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(clean)) !== null) anchors.push(m.index);
  if (anchors.length === 0) return [];

  const hits: ScanHit[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const start = Math.max(0, anchor - window);
    const end = Math.min(clean.length, anchor + window);
    const win = clean.slice(start, end);

    for (const pattern of ALL_PATTERNS) {
      const re = new RegExp(pattern.re.source, pattern.re.flags.includes("g") ? pattern.re.flags : pattern.re.flags + "g");
      let pm: RegExpExecArray | null;
      while ((pm = re.exec(win)) !== null) {
        const absIndex = start + pm.index;
        const key = `${pattern.label}:${absIndex}`;
        if (seen.has(key)) continue;

        if (pattern.negationGuard) {
          const before = win.slice(Math.max(0, pm.index - NEGATION_LOOKBEHIND), pm.index);
          if (NEGATION_RE.test(before)) continue;
        }

        seen.add(key);
        hits.push({
          label: pattern.label,
          severity: pattern.severity,
          phrase: pm[0],
          fragment: clean.slice(
            Math.max(0, absIndex - fragmentRadius),
            Math.min(clean.length, absIndex + pm[0].length + fragmentRadius)
          ),
          index: absIndex,
        });
      }
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Werdykt
// ---------------------------------------------------------------------------

export type Verdict =
  | "przelamanie_wykryte"
  | "uchwala_skladu_powiekszonego"
  | "nadal_cytowany"
  | "brak_cytowan_w_saos";

/**
 * F-06: attitude of a citing fragment toward the examined judgment.
 * Kept alongside the 4 legacy verdicts (backward compat) - each hit carries
 * its own attitude so agents can tell `mentioned` from `potentially_overruled`.
 */
export type CitationAttitude =
  | "mentioned"
  | "followed"
  | "distinguished"
  | "criticized"
  | "potentially_overruled"
  | "unknown";

export function attitudeForLabel(label: string, severity: Severity): CitationAttitude {
  if (severity === "strong") {
    if (label === "odstapienie_od_pogladu" || label === "utrata_mocy_uchwaly")
      return "potentially_overruled";
    return "criticized";
  }
  if (label === "zagadnienie_prawne") return "unknown";
  return "unknown";
}

/**
 * F-06: does this fragment only describe the EXAMINED judgment itself as an
 * enlarged-panel resolution ("uchwala skladu siedmiu sedziow ... III CZP 6/21")?
 * Such a self-description is NOT evidence of a later break in the case-law
 * line. Keep the caution hit only when the window shows ANOTHER resolution:
 * a distinct case signature, or a real referred legal question in context.
 */
export function isSelfDescription(
  fragment: string,
  targetCaseNumber: string,
  targetDate?: string,
): boolean {
  CASE_NO_RE.lastIndex = 0;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const norm = (s: string) => s.replace(/\s*\/\s*/gu, "/").replace(/\s+/gu, " ").trim().toLowerCase();
  const target = norm(targetCaseNumber);
  while ((m = CASE_NO_RE.exec(fragment)) !== null) {
    const sig = norm(m[0].replace(/\s*\/\s*/gu, "/").replace(/\s+/gu, " ").trim());
    if (sig) found.add(sig);
  }
  found.delete(target);
  // A second, distinct signature in the window = plausibly another resolution.
  if (found.size > 0) return false;
  // A legal question referred alongside = real downstream signal even alone.
  if (/zagadnieni[ea][\sa-ząćęłńóśźż]*prawn/i.test(fragment)) return false;
  void targetDate;
  return true;
}

export function computeVerdict(
  totalCiting: number,
  hits: ReadonlyArray<{ severity: Severity | string }>
): Verdict {
  if (hits.some((h) => h.severity === "strong")) return "przelamanie_wykryte";
  if (hits.some((h) => h.severity === "caution")) return "uchwala_skladu_powiekszonego";
  if (totalCiting > 0) return "nadal_cytowany";
  return "brak_cytowan_w_saos";
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  przelamanie_wykryte:
    "WYKRYTO ODSTAPIENIE - w pozniejszym orzecznictwie znaleziono frazy przelamania " +
    "linii w bezposrednim sasiedztwie tej sygnatury. Zweryfikuj pelne teksty trafien " +
    "PRZED zacytowaniem orzeczenia jako aktualnego.",
  uchwala_skladu_powiekszonego:
    "OSTROZNIE - w sasiedztwie sygnatury pojawia sie uchwala skladu powiekszonego lub " +
    "zagadnienie prawne. Linia mogla zostac rozstrzygnieta na nowo - sprawdz pelny tekst.",
  nadal_cytowany:
    "NADAL CYTOWANY - pozniejsze orzeczenia przywoluja te sygnature, nie wykryto fraz " +
    "przelamania w jej sasiedztwie. To heurystyka, nie gwarancja aktualnosci.",
  brak_cytowan_w_saos:
    "BRAK CYTOWAN W SAOS - nie znaleziono pozniejszych orzeczen przywolujacych te " +
    "sygnature w bazie SAOS. To NIE potwierdza aktualnosci - baza nie obejmuje " +
    "wszystkich orzeczen.",
};

/** Jawna deklaracja ograniczen - dolaczana do KAZDEGO wyniku citatora. */
export const CITE_CHECK_DISCLAIMER =
  "OGRANICZENIA: baza SAOS nie obejmuje wszystkich orzeczen (brak WSA/NSA, pokrycie " +
  "nierowne, czesc orzeczen SN poza baza). Brak trafien != potwierdzenie aktualnosci. " +
  "Wykrywanie fraz to heurystyka jezykowa - moze przeoczyc odstapienie wyrazone innymi " +
  "slowami albo zasygnalizowac fraze dotyczaca innego watku. Przed powolaniem sie na " +
  "orzeczenie zweryfikuj pelne teksty trafien (get_judgment) i bazy oficjalne (sn.pl, " +
  "orzeczenia.ms.gov.pl).";
