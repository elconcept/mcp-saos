# mcp-orzeczenia-ms (pilot)

An **independent MCP server** for the public Portal Orzeczeń Sądów Powszechnych
(https://orzeczenia.ms.gov.pl). It complements, **does not replace** the
versioned SAOS dump + SAOS REST fallback. Not deployed by mcp-saos' default
stack; launch only after authorization and routing is configured.

## Tools

- \`ms_search_by_case\`: cases by signature, optional court-code filter.
- \`ms_search\`: text/date/court lookup.
- \`ms_get_metadata\`: source record metadata incl. finality evidence.
- \`ms_get_judgment\`: full text if the source actually serves it.
- \`ms_get_regulations\`: source's cited-regulations tab (not authoritative/complete).
- \`ms_recent_rss\`: recent-publication subset, not a bulk sync mechanism.

All tool results include explicit \`source=portal_orzeczen_ms\`,
\`coverage=published_selection_only\`, and \`status\`:

- \`ok\` (returned data), \`not_found\` (confirmed searchable miss),
- \`upstream_error\` (challenge/timeout/HTTP 400 or broken HTML) and
- \`invalid_arg\` (caller fault).

A missing result cannot establish that the court did not decide a case.
The source may return metadata while refusing the text (HTTP 400 on newer
published decisions, observed in October 2026). **Never synthesize full text**.

## Upstream provenance

\`vendor/orzeczenia_ms.py\`: verbatim snapshot of
\`elconcept/jarmark-prawo/plugins/prawo-pl-orzeczenia-ms/skills/prawo-pl-orzeczenia-ms/scripts/orzeczenia_ms.py\`,
version 2.2.0, blob \`1ea5539d5c9f953dbfc4a7049544f8a488a0ab2d\`.
MIT, copyright Krzysztof Gibek (LICENSE enclosed).
It restricts URLs to the central MS portal and parses documented public
HTML/RSS. The adapter shares a single locked Client, spacing requests by at
least 600ms. No anti-bot bypass, proxy rotation or whole-corpus scraping.

\`webwright-legal-pl\` was inspected as an alternative: Playwright/browser
automation would be heavier and presently remains an opt-in fallback, not
a dependency of this MCP.

## Pilot deployment

Build: \`docker compose -f ms-mcp/compose.yaml build\`, then start the
dedicated service and create a Cloudflare Access rule and tunnel route to
\`mcp-orzeczenia-ms:8000/mcp\`. **Do not add unauthenticated public host ports.**
Only after verifying an authorized request and denial of an unauthenticated
request, register the URL in LEX MCP Portal.

## Federation contract (next phase)

\`search_by_case\` / \`search\` over SAOS should first use the versioned
mirror, then SAOS API on local misses. If both legitimately miss or the SAOS
corpus is known to be partial, invoke this *independent* MS MCP for
common-court decisions. Keep each result's source URL and identity.
Deduplicate only when source ID or court+case+judgment date match reliably.
Do not conflate MS publication dates with judgment dates or SN/NSA/WSA with
common-court coverage. Track unknown/partial coverage explicitly.

### Remaining acceptance gates

- [ ] Docker build/smoke and no secrets printed
- [ ] Live pilot: known case -> metadata and full text; after-2026-09-24 case
      -> metadata or explicit error for unavailable full text
- [ ] Confirm portal authorization and Cloudflare Access fail-closed
- [ ] Add routing/federation logic and duplicate tests
- [ ] Observe limits and contact portal owner for bulk/automated access policy
