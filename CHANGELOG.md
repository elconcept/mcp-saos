# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-10-14

Audyt funkcjonalny, regresyjny i architektoniczny (memo 2026-10-13, ustalenia
F-01…F-11). **Backward-compatible**: te same 4 narzedzia i nazwy; nowe pola sa
opcjonalne (offset/limit, pageNumber citatora) lub dodatkowe w
structuredContent (pagination, chunk, coverage). Fork elconcept zachowany -
lokalny mirror SQLite/FTS5 nadal glownym silnikiem, SAOS API fallbackiem.

### Added

- `get_judgment(id, offset?, limit?)` (F-01): odczyt calej tresci partiami
  (limit max 20000, domyslnie 2000 jak w 1.3.x); structuredContent niesie
  `totalLength`, `returnedLength`, `offset`, `hasMore`, `nextOffset`, `truncated`.
- `search`: structuredContent.pagination (`pageNumber`, `pageSize`,
  `totalResults`, `totalPages`, `hasMore`, `nextPage`) (F-08).
- `saos_cite_check`: parametr `pageNumber` (stronicowanie listy cytujacych,
  100/strona) oraz jawne pokrycie w structuredContent: `totalCandidates`,
  `loadedCandidates`, `scannedFullText`, `unexaminedCandidates`,
  `analysisComplete`, `status` (complete/partial); przy analizie niepelnej
  werdykt ma adnotacje ANALIZA CZESCIOWA (F-05).
- Kazde trafienie citatora ma `attitude`: mentioned / followed / distinguished /
  criticized / potentially_overruled / unknown (F-06).
- Nowe kody bledow: `invalid_arg`, `invalid_date`, `page_out_of_range`; kazdy
  blad niesie `fault` (caller/upstream/network), `retryable`, oraz `status` /
  `retry_after_s` gdy dotyczy (F-07, F-09).
- `GET /status`: `buildVersion`, `gitCommit` (ze zmiennych BUILD_VERSION /
  GIT_COMMIT), `dataSource`, `lastSync`, `indexStatus` (complete / partial /
  stale / unverified); opcjonalna bramka `STATUS_TOKEN` (Bearer) (F-04, F-11).
- Okna synchronizacji maja statusy `verified` / `degraded` / `failed` /
  `retry_pending` (`shortfall`, `checked_at`); agregat w `/status`
  (`windows_verified/degraded/failed`, `index_status`) (F-02, F-03).
- `Store.mirrorIntegrity()`, `Store.close()`, `hashParams()`,
  `isValidIsoDate()`, `citeCoverage()`, `classifyHttpError()` / `HttpError`
  (status, retryAfterS) - do testow i diagnostyki.
- Testy akceptacyjne `test/acceptance.test.mjs` (14 testow, offline, mapowanie
  na 11 scenariuszy odbioru z memo); `npm run test:unit` obejmuje je razem z
  `cite-check.test.mjs`.

### Fixed

- Bledne daty (`xyz`, `2021-13-01`, `2021-02-30`) zwracaja `invalid_date`
  (fault=caller) zamiast cichego ignorowania filtra lub falszywego zera (F-07).
- Strona poza zakresem przy totalResults>0 zwraca `[page_out_of_range]` z
  prawdziwa liczba wynikow i paginacja, nie "brak orzeczen" (F-08).
- Upstream 404 -> `not_found`, upstream 400 -> `invalid_arg`; `id: 0` i `"abc"`
  to `invalid_arg`, nie `missing_arg` ani `upstream_error` (F-09).
- Citator odrzuca frazy skladu powiekszonego opisujace SAMO badane orzeczenie
  (np. "uchwala skladu siedmiu sedziow ... III CZP 6/21" bez innej sygnatury) -
  sygnal caution wymaga innej uchwaly albo zagadnienia prawnego (F-06).
- `GET /status` nie ujawnia surowych parametrow zapytan ani ID upstream
  (tylko `params_hash` i liczniki); logi stderr tez haszuja parametry (F-04).
- Nieudana / niepelna synchronizacja okna raportowana jest jako `degraded` /
  `failed`, nigdy jako pelny sukces (F-03).
- HTTP: brak rotacji obwodu Tor przy 401/403 (kontrola dostepu zrodla);
  429 respektuje `Retry-After` (sek. 5 memo).
- Dokumentacja: `get_judgment` nie obiecuje juz "pelnego orzeczenia" bez
  zastrzezen (offset/limit); rozroznienie `legalBase` (indeks legalBases -
  podstawa rozstrzygniecia) vs `referencedRegulation` (indeks
  referencedRegulations - kazde przywolanie) w opisach narzedzi, README i
  AGENTS.md; `package.json` wskazuje repozytorium forka (F-10, F-11).
- Import `dist/index.js` / `dist/sync.js` nie startuje juz serwera ani
  synchronizacji (straznik `require.main === module`) - do testowania bez
  efektow ubocznych.

## [1.3.0] - 2026-10-12

Lokalna kopia dumpu SAOS jako silnik wyszukiwania (fork elconcept). **Backward-compatible** - narzedzia, schematy i opisy bez zmian (descriptor lock OK).

### Added

- `src/sync.ts` - pobieranie calej bazy z oficjalnego `/api/dump/judgments` (okna dat, pageSize 100, wznawianie po przerwaniu, kontrola liczby kazdego okna wzgledem API wyszukiwania) i codzienna aktualizacja przyrostowa (`sinceModificationDate`, zakladka 2 dni). Nazwy sadow i wydzialow z `/api/dump/commonCourts` i `/api/dump/scChambers`.
- `src/store.ts` - SQLite (`node:sqlite`, FTS5): surowy JSON dumpu (deflate) zwracany bez zmian + indeks pelnotekstowy (tresc, sygnatury, sklad, podstawy prawne, przywolane akty, slowa kluczowe). rowid = data*1e7 + id, wiec sortowanie po dacie DESC i zakresy dat sa tanie.
- `src/engine.ts` - najpierw lokalnie; gdy lokalnie pusto, zapytanie do API SAOS. Wynik z API, ktorego nie ma lokalnie = rozbieznosc: zwracany (`structuredContent.source = "saos_api_fallback"`, adnotacja w tekscie), zapisany w tabeli `discrepancies` i na stderr. Do czasu ukonczenia pierwszego pobrania wszystko idzie do API jak dotad.
- `structuredContent.source`: `local_dump` / `saos_api` / `saos_api_fallback` (pole dodatkowe, `citations` bez zmian).
- Transport Streamable HTTP (`MCP_TRANSPORT=http`, `/mcp`, bezstanowy) + `/healthz` + `/status` (stan kopii, ostatnie rozbieznosci). W trybie HTTP harmonogram synchronizacji (`SAOS_SYNC_AT`, domyslnie 03:30).
- Tor jako zapasowa droga: ponowienia zapytan ida przez SOCKS (`SAOS_TOR_PROXY`) z nowym obwodem.
- Dockerfile/compose/workflow wdrozenia na NAS (stack Portainera `mcp-saos`, https://mcp-saos.xlap.pl/mcp).

### Changed

- Wyszukiwanie lokalne: slowa bez cudzyslowu sa skracane o koncowke fleksyjna i szukane prefiksowo (`umowa` -> `umow*`), frazy w cudzyslowie jako sasiadujace slowa (tez odmienione, jak w SAOS), `-slowo` wyklucza, `OR` laczy. Wyniki moga sie roznic od Solr SAOS (inny stemming); kolejnosc jak w SAOS (data DESC).

## [1.2.0] - 2026-07-13

Citator "czy wyrok zyje". **Backward-compatible** - istniejace 3 narzedzia bez zmian.

### Added

- Tool `saos_cite_check(caseNumber, courtType?, maxScan?, deepScan?)` - adaptacja koncepcji `cite_check` z chrisryugj/korean-law-mcp (MIT), kod od zera pod SAOS. Pipeline: sygnatura -> pelnotekstowe wyszukiwanie pozniejszych orzeczen cytujacych -> skan uzasadnien pod frazy przelamania linii orzeczniczej W OKNIE +-500 znakow wokol sygnatury -> werdykt `przelamanie_wykryte` / `uchwala_skladu_powiekszonego` / `nadal_cytowany` / `brak_cytowan_w_saos`.
- 11 wzorcow fraz (8 strong, 3 caution, w tym guard negacji dla "poglad odosobniony") - KAZDA fraza zweryfikowana zywym zapytaniem do SAOS API 2026-07-13, dowody w `docs/CITE-CHECK.md`. Egzemplarze przypiete w testach jednostkowych.
- `structuredContent`: `verdict`, `target`, `hits[]` (sygnatura cytujacego, data, fraza, fragment +-200 znakow - grounding), `disclaimer`, `citations` (kontrakt bez zmian).
- Jawna deklaracja ograniczen w KAZDEJ odpowiedzi citatora: baza SAOS nie obejmuje wszystkich orzeczen; brak trafien != potwierdzenie aktualnosci.
- Testy jednostkowe offline (`npm run test:unit`, 41 testow: parser sygnatury, granice slowa, okno skanu, guard negacji, tabela egzemplarzy) + TEST 5 live w smoke tescie. CI odpala `npm test` po buildzie.

### Fixed

- README: usuniete nieaktualne twierdzenie "baza historyczna do 2016-2018" - SAOS ma dobrze pokryte lata 2024-2026 (niejednolicie wg typu sadu), co kod deklarowal od 1.1.x.

## [1.1.2] — 2026-06-26

### Fixed

- serverInfo `version` zsynchronizowany z `package.json` (raportowal 1.1.0 mimo paczki 1.1.1). Kosmetyczne, kontrakt narzedzi bez zmian.

## [1.1.0] — 2026-05-25

Retrofit do kanonu MCP MateMatic (pattern z dograh-hq/dograh v1.31.0, BSD-2). **Backward-compatible** — istniejacy klienci dzialaja bez zmian.

### Added

- `instructions` w konstruktorze Server — procedural orchestration (kolejnosc wywolan, twarde ograniczenia: pokrycie nierowne / OCR daty / brak admin courts, iteracja po bledach, styl odpowiedzi). LLM widzi PRZED pierwszym tool call.
- `ToolAnnotations` per tool — `readOnlyHint=true`, `idempotentHint=true`, `destructiveHint=false`. Klient MCP moze auto-approve wywolania bez monitu.
- Strukturalne `ErrorCode` w odpowiedziach: `missing_arg`, `not_found`, `upstream_error`, `invalid_court_type`. Format `[code] tekst` w content + `structuredContent.error_code`.
- Walidacja `courtType` przed wywolaniem upstream API — jasny komunikat dla ADMINISTRATIVE (sady admin w mcp-nsa, nie tu).
- Drift test (`npm run drift`) — asercja spojnosci INSTRUCTIONS + ErrorCode + TOOLS + kodu errorResult().

## [1.0.0] — 2026-05-20

Initial public release.

Polish judgments: common courts, Supreme Court, Constitutional Tribunal, KIO (via SAOS API). 3 tools: search / get_judgment / search_by_case. structuredContent.citations contract.

### Highlights

- Node 18+ stdio MCP server, single `dist/index.js` entry.
- LIVE smoke-tested on real data.
- `structuredContent.citations` consumed by [Patron](https://github.com/matematicsolutions/patron)
  and any other MCP-aware legal agent.
- MIT license, 500 ms request throttle, zero secrets required.

[1.0.0]: https://github.com/matematicsolutions/mcp-saos/releases/tag/v1.0.0
