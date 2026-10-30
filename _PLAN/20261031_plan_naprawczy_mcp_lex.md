# SAOS — plan poprawy walidacji, cytatora i treści przy odczycie przez portal

> Audyt 2026-10-31: wyniki wywołań narzędzi bezpośrednio w kontenerach, przez portal lex oraz analiza kodu elconcept. To **plan**, nie wdrożenie. **POTWIERDZONE** = zaobserwowany objaw lub błąd w kodzie; **DO SPRAWDZENIA** = hipoteza.

## Zasady wspólne
- Interfejs użytkownika, wejściowe zapytania w języku naturalnym, wyniki, opisy, komentarze i błędy — **wyłącznie po polsku, bez selektora języka**. Identyfikatory techniczne (sygnatura, ECLI/CELEX, URL, nazwy modeli) bez zmian. Jeżeli występuje stary parametr `lang`, fazowo ukryć go w schemacie i ignorować dla zgodności, zawsze używając polskiego.
- Urzędowy tekst prawny oznaczyć źródłem i stanem; komentarz i tłumaczenie robocze to inne kategorie. Nie podszywać się pod wersje urzędowe, nie dopowiadać treści. Zachować `content` i `structuredContent` na całej ścieżce MCP.
- Każda zmiana: fixture/regresja → staging → porównanie bezpośrednio/Cloudflare/lex → rollout z migawką i rollbackiem; bez ujawniania sekretów i bez niekontrolowanych zmian produkcyjnych.

## Materiał dowodowy
- **POTWIERDZONE:** `search(caseNumber='V CSK 145/14')`, `search_by_case`, `get_judgment(id=166511)` i `saos_cite_check` odpowiadały; dane z `local_dump`. `get_judgment(offset=0,limit=450)` zwraca `totalLength=7686`, `returnedLength=450`, `hasMore=true`, `nextOffset=450` w `structuredContent`, lecz przez portal widoczne były głównie metadane, nie faktyczny chunk `content`.
- **SKORYGOWANE USTALENIE:** `pageSize=1` jest poza udokumentowanym zakresem (min 10, max 100), więc 10 wyników w poprzednim teście **nie jest dowodem** błędu stronicowania; trzeba zweryfikować obsługę argumentów niepoprawnych.
- **POTWIERDZONE:** cytator z `deepScan=false` zwrócił `analysisMode='snippets_only'`, `scannedFullText=0`, `fullTextCoverage=1`, `analysisComplete=true`, `verdict='brak_cytowan_w_saos'` w wybranej próbie. Kod `citeCoverage()` oblicza fullTextCoverage=1 przy pustym zbiorze, co technicznie może być poprawne, ale dla użytkownika mylące przy braku kontroli pełnych tekstów.
- **DO SPRAWDZENIA:** jak citator liczy `total_citing_in_saos` względem `total_citing_found`; reprezentatywność lokalnego mirrora, niewidoczne orzeczenia, ryzyko zbyt mocnego wniosku o „braku cytowań”.

## Plan
1. **P0 — MCP `content`:** test na `get_judgment(166511, offset=0, limit=450)` na kontenerze, Cloudflare i `lex`; zachować dosłowny tekst chunku bez konwersji do samego `citations`. Sprawdzić `nextOffset` i kompletność 7686 znaków przy iteracji.
2. **P0 — cytator:** przy `snippets_only` zawsze dodać jednoznacznie `weryfikacja wstępna — brak analizy pełnych tekstów`; nie używać sformułowań sugerujących pełną weryfikację. Rozróżnić wyczerpanie zbioru kandydatów i realne sprawdzenie orzeczeń w pełnym tekście. Werdykt o braku cytowań tylko w granicach jawnego pokrycia SAOS.
3. **P1 — walidacja:** wszystkie argumenty `pageSize<10`, `pageNumber<0`, `offset<0`, błędne `id`, `limit>20000`: kontrolowany, polski kod błędu z wymaganym zakresem, bez cichej normalizacji jeśli kontrakt wymaga odrzucenia.
4. **P1 — mirror:** raport aktualności i pokrycia `local_dump` vs SAOS API, kategorie niepełności i niezweryfikowane zero wyników; test kontrolny po sygnaturze i frazie, także bez wymaganego IDR analogii — nie mieszać wnioskowania z danych niekompletnych.
5. **P2 — regresja:** fixtures cytatora z 0, 1 i wieloma powołaniami, rzeczywistymi referencjami, `deepScan` i `maxScan` oraz dwiema stronami wyników; dostosować opisy i polskie komunikaty.

## Akceptacja
- `get_judgment` przez portal dostarcza polski tekst chunku, a komplet chunków równa się treści w backendzie.
- `deepScan=false` nie jest przedstawiany jako kompletna analiza pełnotekstowa; `analysisComplete` opisuje dokładnie zakres i nie jest mylone z pewnością aktualności orzeczenia.
- Nieprawidłowe `pageSize` zwraca jawne zachowanie zgodne z walidatorem; liczba wyników i pochodzenie danych są prawidłowe.

## Pliki / dowody
`src/index.ts` (`citeCoverage`, `formatJudgment`, `TOOLS`), `src/cite-check.ts`, `src/engine.ts`, `test/`, kontener `mcp-saos`.
