# saos_cite_check - citator "is the judgment alive"

Adapted from the `cite_check` tool in [chrisryugj/korean-law-mcp](https://github.com/chrisryugj/korean-law-mcp)
(MIT), a Korean Shepard's-style citator. The code here is written from scratch
for the SAOS API; what we borrowed is the concept: track later judgments that
cite a given case number, scan their reasoning for overruling language near
the citation, and say out loud what the tool cannot see.

## How it works

1. **Parse** the case number (sygnatura akt) out of free text, e.g.
   `"uchwala SN z 7.05.2021 r., III CZP NN/RR"` -> `III CZP NN/RR`.
2. **Locate the target judgment** via `caseNumber` search, to get its date.
   Identical signatures repeat across courts, so on ambiguity the tool prefers
   Supreme Court > Constitutional Tribunal > the rest, and says so. If the
   target is not in SAOS at all (common for Supreme Court resolutions), the
   tool continues without the date filter and flags that in the output.
3. **Find citing judgments**: quoted full-text search `all="<sygnatura>"`,
   filtered to judgments later than the target, sorted newest first.
4. **Scan for overruling phrases** in a window of +-500 characters around each
   occurrence of the signature. A phrase outside the window is ignored: it may
   concern a different judgment cited in the same document. Two passes:
   - free pre-scan of the snippets returned by the search endpoint,
   - deep scan of full texts for the top N citing judgments (default 8,
     Supreme Court and resolutions first, then newest).
5. **Verdict**, three-step plus the empty case:

| Verdict | Meaning |
|---|---|
| `przelamanie_wykryte` | overruling language found next to the signature - read the hit's full text before citing |
| `uchwala_skladu_powiekszonego` | an enlarged-panel resolution or a pending legal question appears next to the signature |
| `nadal_cytowany` | later judgments cite it, no signals found (heuristic, not a guarantee) |
| `brak_cytowan_w_saos` | no later citations found in SAOS - which does NOT confirm the judgment is current |

Every hit carries the citing case number, date, matched phrase and a +-200
character fragment, so a human can verify the treatment without trusting the
label. Every response ends with an explicit limitation notice.

## Verified phrase list

Rule: a phrase enters the pattern list only if it demonstrably occurs in real
judgment reasoning. Every pattern below was verified with a live quoted query
against `https://www.saos.org.pl/api/search/judgments?all="<phrase>"` on
**2026-07-13**, and the exemplar fragment was confirmed verbatim in the listed
judgment's text. The same exemplars are pinned in
`test/cite-check.test.mjs`, so the patterns cannot silently drift away from
real court language.

### STRONG - overruling / departure signals

| Phrase (queried) | SAOS hits | Confirmed in | Pattern label |
|---|---|---|---|
| "odstępuje od poglądu wyrażonego" | 7 | II C 94/16 (2024-10-25, id 532732) | `odstapienie_od_pogladu` |
| "odstąpić od poglądu wyrażonego" | 40 | I C 221/23 (2023-11-23, id 496821) | `odstapienie_od_pogladu` |
| "odstąpił od poglądu" | 127 | I C 3346/24 (2025-03-05, id 543228) | `odstapienie_od_pogladu` |
| "odstąpienie od dotychczasowej linii orzeczniczej" | 13 | I C 395/24 (2024-08-28, id 518098) | `odstapienie_od_pogladu` |
| "nie podziela poglądu" | 15065 | I C 1304/24 (2026-05-11, id 547476) | `nie_podziela_pogladu` |
| "nie podziela stanowiska" | 27661 | IX U 157/25 (2026-05-27, id 546990) | `nie_podziela_pogladu` |
| "pogląd ten utracił aktualność" | 5 | VI ACa 487/19 (2019-07-29, id 399087) | `utrata_aktualnosci` |
| "utracił aktualność" | 199 | IV Ua 43/23 (2024-06-21, id 509185) | `utrata_aktualnosci` |
| "zdezaktualizował" | 1338 | VI Ka 1518/25 (2026-06-08, id 547116) | `zdezaktualizowanie` |
| "traci moc uchwała" | 30 | I C 504/24 (2026-01-14, id 540638) | `utrata_mocy_uchwaly` |
| "nie zasługuje na aprobatę pogląd" | 426 | I C 79/23 (2025-09-19, id 539562) | `brak_aprobaty` |
| "odmiennie niż w wyroku" | 32 | I AGa 164/22 (2023-10-26, id 494913) | `rozbieznosc_orzecznicza` |
| "odmiennie niż w uchwale" | 10 | II Ca 788/13 (2014-04-01, id 252135) | `rozbieznosc_orzecznicza` |
| "pogląd odosobniony" | 91 | II Ca 144/25 (2025-04-08, id 530526) | `poglad_odosobniony` |

`poglad_odosobniony` carries a negation guard: the confirmed exemplar is in
fact "Nie jest to pogląd odosobniony" (the view is settled, the opposite
treatment), so the scanner rejects matches directly preceded by a negation.

### CAUTION - enlarged panel / pending legal question

| Phrase (queried) | SAOS hits | Confirmed in | Pattern label |
|---|---|---|---|
| "uchwała składu siedmiu sędziów" | 17996 | I Ca 115/26 (2026-06-10, id 547286) | `uchwala_skladu_siedmiu` |
| "uchwała pełnego składu" | 4710 | I Ca 94/26 (2026-04-15, id 547376) | `uchwala_pelnego_skladu` |
| "zagadnienie prawne przedstawione do rozstrzygnięcia" | 200 | III AUa 359/22 (2023-01-24, id 483378) | `zagadnienie_prawne` |
| "przedstawić zagadnienie prawne do rozstrzygnięcia składowi siedmiu sędziów" | 13 | I KZP 17/15 (2016-02-25, id 244680) | `zagadnienie_prawne` |

### Candidates tested and rejected

| Phrase | Why rejected |
|---|---|
| "traci moc zasada prawna" | 0 hits in SAOS |
| "stracił na aktualności" | 783 stemmed hits, but no literal occurrence confirmed in top results; covered by `utrata_aktualnosci` and `zdezaktualizowanie` |
| "odstępując od dotychczasowej" | 17 stemmed hits, no literal confirmation; inflections covered by `odstapienie_od_pogladu` |

Note on the raw hit counts: the SAOS search engine stems Polish, so a quoted
query also matches inflected variants. The counts locate the phrase family;
the confirmation column is the literal proof.

## Word boundaries

Case-number matching uses hard boundaries: `III CZP 6/21` must not match
inside `III CZP 6/215` or `XIII CZP 6/21`. Short legal tokens without word
boundaries produce mass noise (the `\b` rule that turned 26 false `KP` hits
into 2 real ones in an earlier MateMatic audit).

## Known limitations

- SAOS coverage is uneven: no administrative courts (WSA/NSA), and many
  Supreme Court resolutions are absent as standalone records even when
  thousands of judgments cite them.
- Phrase detection is a language heuristic. A court can depart from a line of
  case law in words this list does not contain, and a listed phrase can refer
  to a side issue rather than the checked judgment (the window reduces, but
  does not eliminate, this).
- "No hits" is not "still good law". The tool prints this in every response.
- The deep scan reads the top N citing judgments only; hits beyond page one of
  the citing search (100 results) are counted but not scanned.
