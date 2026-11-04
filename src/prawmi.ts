/**
 * Optional PrawMi fallback for mcp-saos, through a private HTTP adapter.
 * No scraping code, PostgreSQL credentials or extra MCP tools in mcp-saos.
 */
export interface NormalizedCase {
  canonical: string;
  slug: string;
  explicitYear: number | null;
}

export interface PrawMiDocument {
  status: "found";
  source: "prawmi";
  signature: string;
  url: string;
  court: string | null;
  judgment_date: string | null;
  judgment_type: string | null;
  text: string;
  cached: boolean;
  embedding_status?: string;
  summary_status?: string;
  warnings?: string[];
}

export class CaseSignatureError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ROMANS = new Set([
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
]);

export function normalizeCaseSignature(input: unknown): NormalizedCase {
  if (typeof input !== "string") {
    throw new CaseSignatureError("invalid_signature", "Sygnatura musi byc tekstem.");
  }
  let v = input.normalize("NFKC").replace(/[\u200b\ufeff]/g, "").trim();
  if (!v || v.length > 160) {
    throw new CaseSignatureError("invalid_signature", "Pusta lub zbyt dluga sygnatura.");
  }
  v = v.replace(/^\s*(?:(?:sygn(?:atura)?\.?\s*(?:akt(?:a)?\.?\s*)?)|(?:nr\.?\s*(?:sprawy|sygnatury)\s*))[:.\-\s]*/i, "").trim();
  if (v.includes("..") || v.includes("://") || /^(https?|file)/i.test(v)) {
    throw new CaseSignatureError("invalid_signature", "Adres URL lub sciezka to nie sygnatura.");
  }
  if (!/^[A-Za-z0-9\s._/\\,;:\-\u2010-\u2015\u2212]+$/.test(v)) {
    throw new CaseSignatureError("invalid_signature", "Niedozwolone znaki.");
  }
  v = v.replace(/([A-Za-z])(?=\d)|(?<=\d)([A-Za-z])/g, "$1 $2");
  let tokens = v.split(/[\s._/\\,;:\-\u2010-\u2015\u2212]+/).filter(Boolean);
  if (tokens.length >= 3 && /^[IVX]$/i.test(tokens[0]) && /^[IVX]$/i.test(tokens[1])) {
    let i = 0;
    while (i < tokens.length - 1 && i < 8 && /^[IVX]$/i.test(tokens[i])) i++;
    const roman = tokens.slice(0, i).join("").toUpperCase();
    if (ROMANS.has(roman)) tokens = [roman, ...tokens.slice(i)];
  }
  if (tokens.length && !ROMANS.has(tokens[0].toUpperCase())) {
    const first = tokens[0];
    if (/^[IVX]/i.test(first)) {
      for (let i = Math.min(5, first.length - 1); i > 0; i--) {
        if (ROMANS.has(first.slice(0, i).toUpperCase()) && /^[A-Za-z]+$/.test(first.slice(i))) {
          tokens = [first.slice(0, i), first.slice(i), ...tokens.slice(1)];
          break;
        }
      }
    }
  }
  const start = tokens.findIndex((x) => /^\d+$/.test(x));
  if (start < 1 || !tokens.slice(0, start).every((x) => /^[A-Za-z]+$/.test(x))) {
    throw new CaseSignatureError("invalid_signature", "Nie mozna rozpoznac repertorium.");
  }
  let units = tokens.slice(0, start);
  const tail = tokens.slice(start);
  const nums: string[] = [];
  while (tail.length && /^\d+$/.test(tail[0])) nums.push(tail.shift()!);
  if (!nums.length || tail.some((x) => !/^[A-Za-z]+$/.test(x))) {
    throw new CaseSignatureError("invalid_signature", "Niepoprawny numer sprawy lub sufiks.");
  }
  let number = "", year = "";
  if (nums.length === 1) {
    const run = nums[0];
    if (run.length < 3 || run.length > 12) {
      throw new CaseSignatureError("ambiguous_signature", "Nie mozna rozdzielic numeru i roku.");
    }
    const longYear = run.length >= 6 && Number(run.slice(-4)) >= 1800 && Number(run.slice(-4)) <= 2099;
    number = run.slice(0, longYear ? -4 : -2);
    year = run.slice(longYear ? -4 : -2);
  } else if (nums.at(-1)!.length === 2 || nums.at(-1)!.length === 4) {
    number = nums.slice(0, -1).join("");
    year = nums.at(-1)!;
  } else if (nums.length >= 5 && nums.slice(-4).every((x) => x.length === 1)
             && Number(nums.slice(-4).join("")) >= 1800 && Number(nums.slice(-4).join("")) <= 2099) {
    number = nums.slice(0, -4).join("");
    year = nums.slice(-4).join("");
  } else if (nums.length >= 3 && nums.at(-2)!.length === 1 && nums.at(-1)!.length === 1) {
    number = nums.slice(0, -2).join("");
    year = nums.slice(-2).join("");
  } else {
    throw new CaseSignatureError("ambiguous_signature", "Nie mozna rozdzielic numeru i roku.");
  }
  if (!number || number.length > 9 || Number(number) === 0 || ![2, 4].includes(year.length)) {
    throw new CaseSignatureError("invalid_signature", "Niepoprawny numer sprawy lub rok.");
  }
  const explicitYear = year.length === 4 ? Number(year) : null;
  if (explicitYear !== null && (explicitYear < 1800 || explicitYear > 2099)) {
    throw new CaseSignatureError("invalid_signature", "Rok poza zakresem.");
  }
  if (explicitYear !== null) year = year.slice(-2);
  if (units.length >= 3 && ROMANS.has(units[0].toUpperCase())
      && units.slice(1).every((x) => x.length === 1)) {
    units = [units[0], units.slice(1).join("")];
  }
  const caseNo = String(Number(number));
  return {
    canonical: units.join(" ") + " " + caseNo + "/" + year + (tail.length ? "/" + tail.join("-") : ""),
    slug: [...units, caseNo, year, ...tail].join("-").toLowerCase(),
    explicitYear,
  };
}

/** Disabled by default; fails closed without a configured internal adapter. */
export async function lookupPrawMi(
  caseNumber: string,
  fetcher: typeof fetch = fetch,
): Promise<PrawMiDocument | null> {
  if (process.env.ORZECZENIA_FALLBACK !== "1") return null;
  const normalized = normalizeCaseSignature(caseNumber);
  const base = process.env.ORZECZENIA_API_URL || "http://mcp-orzeczenia:8000";
  const url = new URL("/v1/judgments/lookup", base);
  url.searchParams.set("signature", caseNumber);
  const response = await fetcher(url.toString(), {
    method: "GET", redirect: "error",
    signal: AbortSignal.timeout(25000),
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CaseSignatureError(
      "prawmi_upstream_error", "Wewnetrzny adapter PrawMi: HTTP " + response.status,
    );
  }
  const raw = await response.json() as Partial<PrawMiDocument>;
  if (raw.status !== "found" || raw.source !== "prawmi" ||
      typeof raw.signature !== "string" || typeof raw.text !== "string" ||
      typeof raw.url !== "string" || raw.text.length < 50) {
    throw new CaseSignatureError("prawmi_response_invalid", "Niepoprawny format odpowiedzi adaptera.");
  }
  if (normalizeCaseSignature(raw.signature).slug !== normalized.slug) {
    throw new CaseSignatureError("signature_mismatch", "Sygnatura strony nie zgadza sie z zapytaniem.");
  }
  const source = new URL(raw.url);
  if (source.protocol !== "https:" || source.hostname !== "prawmi.pl") {
    throw new CaseSignatureError("prawmi_response_invalid", "Niezweryfikowany URL zrodla.");
  }
  return raw as PrawMiDocument;
}
