# Sources ledger - Poland / common courts, SN, TK, KIO (PL)

Machine-diffable record of every Legal Data Hunter (`worldwidelaw/legal-sources`) source we have
checked for this repo's scope, and what we did about it. Purpose: the next gap-audit
(eu-legal-mcp PLAYBOOK.md section 8) is a file diff against a fresh `manifest.yaml`, not a re-run
of hours of research. Machine-read by `eu-legal-mcp/gap_scan.py`.

This repo is single-source by constitution (AGENTS.md): SAOS only. Rows below record what SAOS
covers, what it deliberately does NOT, and where those gaps are served instead.

| LDH id | LDH name | LDH status @ check | Our status | Our tool(s) | Notes / rejection reason |
|---|---|---|---|---|---|
| PL/SAOS | SAOS - System Analizy Orzeczen Sadowych | complete | shipped | `search`, `get_judgment`, `search_by_case` | primary source of this repo (saos.org.pl API, keyless). Common courts + SN + TK + KIO. Verified live 2026-07-08: `courtType=CONSTITUTIONAL_TRIBUNAL` and `SUPREME` return results (see test/smoke.mjs). |
| PL/ConstitutionalCourt | Trybunal Konstytucyjny | complete | shipped | `search` (`courtType=CONSTITUTIONAL_TRIBUNAL`) | served via SAOS (`duplicate` channel of PL/SAOS for our purposes); live regression test added 2026-07 (commit 7ba8080). |
| PL/SupremeCourt | Sad Najwyzszy (dane.gov.pl channel) | complete | shipped | `search` (`courtType=SUPREME`) | served via SAOS. The dane.gov.pl bulk channel would add no lookup capability - `duplicate`. |
| PL/SN | Sad Najwyzszy (sn.pl portal) | blocked | rejected | - | `duplicate` - SN judgments served via SAOS (`courtType=SUPREME`); sn.pl portal itself not probed this round because the corpus is already covered. |
| PL/KIO | Krajowa Izba Odwolawcza | complete | shipped | `search` (`courtType=NATIONAL_APPEAL_CHAMBER`) | KIO present in SAOS; the dedicated richer connector is `kio-orzeczenia-mcp` (orzeczenia.uzp.gov.pl direct). |
| PL/NSA | NSA/WSA (CBOSA) | blocked | rejected | - | out of scope BY DESIGN - SAOS does not index administrative courts. Served by `mcp-nsa` (which reversed the LDH block live 2026-07-08: 2 390 229 judgments open via form POST). |
| PL/KIS-EUREKA | EUREKA tax interpretations | complete | rejected | - | out of scope (not case law, and this repo is single-source). Served by `mcp-eureka` (shipped 2026-07-08, 550 889 docs). |

The `LDH status @ check` column records what LDH said WHEN WE CHECKED (2026-07-08 manifest pull).

## Status vocabulary

- `shipped` - live in this repo, has at least one MCP tool, tested and published.
- `rejected` - scouted, deliberately NOT built; `Notes` gives the reason (LDH taxonomy or
  MateMatic-specific: `duplicate`, `no_full_text_access`, `needs_separate_subscription`, ...).
- `todo` - LDH has it as `complete`, we have not evaluated it yet.

## Not on this list

Anything NOT in this table has simply not been checked yet against this country's LDH sources.
Fleet map for Poland: `mcp-saos` (this), `mcp-nsa` (admin courts), `mcp-eureka` (tax
interpretations), `kio-orzeczenia-mcp` (KIO direct), `sejm-eli-mcp` / `mcp-isap` (legislation),
`mcp-krs` (companies register). Regulator decisions (UODO/KNF/UKE/URE/UOKIK) are tracked as
todo rows in `kio-orzeczenia-mcp/SOURCES.md` (nearest-neighbor ledger for quasi-judicial
bodies), including the full UODO machine-backend probe of 2026-07-08.
