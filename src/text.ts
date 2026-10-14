/**
 * Text helpers: HTML stripping (shared with the formatters) and translation of
 * user queries into SQLite FTS5 MATCH expressions for the local dump.
 */

export function stripHtml(html: string): string {
  // Remove HTML tags and decode basic entities
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Same folding as the FTS5 tokenizer (unicode61 remove_diacritics 2): lower
// case + combining marks removed. "ł" has no decomposition and stays "ł".
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function tokens(s: string): string[] {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Light Polish stemming for recall: SAOS (Solr) matches inflected forms
// ("umowa" finds "umowy"); FTS5 has no Polish stemmer, so an unquoted word
// loses its inflection ending and becomes a prefix query ("umow*").
const SUFFIXES = [
  "owaniem", "owania", "owanie", "owaniu", "osciami", "osciach", "osciom", "oscia", "osci",
  "ami", "ach", "ego", "emu", "ymi", "imi", "ych", "ich", "owi", "ow", "om", "em", "ej",
  "ie", "iu", "ia", "ii", "ym", "im", "a", "e", "i", "o", "u", "y",
].sort((x, y) => y.length - x.length);
const MIN_STEM = 4;

export function stemTerm(tok: string): string {
  if (/\d/.test(tok) || tok.length <= MIN_STEM) return tok;
  for (const suf of SUFFIXES) {
    if (tok.endsWith(suf) && tok.length - suf.length >= MIN_STEM) {
      return `${tok.slice(0, -suf.length)}*`;
    }
  }
  return `${tok}*`;
}

function phrase(toks: string[]): string {
  return `"${toks.join(" ")}"`;
}

/**
 * Free-text query -> FTS5 expression. "quoted phrases" match adjacent words
 * (inflected), other words are stemmed prefixes, all ANDed; OR (upper case) between two items and
 * a leading "-" (NOT) are honoured. Returns null when nothing searchable is left.
 */
export function buildTextQuery(input: string, stem = true): string | null {
  const parts: string[] = [];
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  let pendingOr = false;
  while ((m = re.exec(input)) !== null) {
    let expr: string | null = null;
    let negate = false;
    if (m[2] !== undefined) {
      // Phrase with inflected words, like SAOS: "zadoscuczyn* + za + krzywd*"
      // (FTS5 "a + b" = adjacent tokens; digits and short words stay exact).
      const t = tokens(m[2]);
      if (t.length) expr = stem ? t.map(stemTerm).join(" + ") : phrase(t);
      negate = m[1] === "-";
    } else {
      const raw = m[3];
      if (raw === "OR") {
        if (parts.length) pendingOr = true;
        continue;
      }
      if (raw === "AND") continue;
      negate = raw.startsWith("-") && raw.length > 1;
      const t = tokens(negate ? raw.slice(1) : raw);
      if (t.length === 1) expr = stem ? stemTerm(t[0]) : t[0];
      else if (t.length > 1) expr = phrase(t); // "6/21", "k.c." -> adjacent tokens
    }
    if (!expr) continue;
    if (negate && parts.length) {
      parts[parts.length - 1] = `(${parts[parts.length - 1]} NOT ${expr})`;
    } else if (negate) {
      continue; // FTS5 cannot start with NOT; a lone negation is dropped
    } else if (pendingOr && parts.length) {
      parts[parts.length - 1] = `(${parts[parts.length - 1]} OR ${expr})`;
    } else {
      parts.push(expr);
    }
    pendingOr = false;
  }
  return parts.length ? parts.join(" AND ") : null;
}

/** Exact token phrase (case numbers, judge names): no stemming. */
export function buildPhrase(input: string): string | null {
  const t = tokens(input);
  return t.length ? phrase(t) : null;
}

/** All tokens required, any order, exact (judge names). */
export function buildAllTokens(input: string): string | null {
  const t = tokens(input);
  return t.length ? t.join(" AND ") : null;
}
