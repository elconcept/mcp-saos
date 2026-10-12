# AGENTS.md - mcp-saos

An [agents.md](https://agents.md) standard file (Linux Foundation / Agentic AI Foundation) - the canonical instructions for AI agents working with this repository. Read natively by Cursor, Codex (OpenAI), Jules (Google), Devin / Windsurf, Aider, Amp, Factory, GitHub Copilot.

## Project goal

An **MCP (Model Context Protocol)** server for **case law of the Polish common courts, the Sad Najwyzszy (Supreme Court), the Trybunal Konstytucyjny (Constitutional Tribunal), and the KIO (National Appeal Chamber)** - via the public SAOS (System Analizy Orzeczen Sadowych - the courts' public case-law database) API, `https://saos.org.pl`.

One of MateMatic's 5 Polish-law connectors: [`mcp-saos`](https://github.com/matematicsolutions/mcp-saos) (this one), [`mcp-nsa`](https://github.com/matematicsolutions/mcp-nsa), [`mcp-isap`](https://github.com/matematicsolutions/mcp-isap), [`mcp-krs`](https://github.com/matematicsolutions/mcp-krs), [`mcp-eu-sparql`](https://github.com/matematicsolutions/mcp-eu-sparql).

The connector plugs in via `mcp-servers.json` in any protocol-compliant client (Claude Code, Patron, Cursor, Codex, Continue, etc.).

## MateMatic context (HARD CONSTRAINTS)

The repo is run by [MateMatic Solutions](https://matematicsolutions.com). The connector is **trust infrastructure** - it serves any LegalTech product that needs citations from Polish case law, in any jurisdiction.

- **Every tool call MUST return `structuredContent.citations`** with: judgment title, canonical URL (SAOS), court, date, case number. This is the product contract.
- **No caching of client data** - the connector does not log queries. Fork elconcept (1.3.0+): judgments are served from a local mirror of the public SAOS dump (`src/sync.ts`, `src/store.ts`, `src/engine.ts`); only queries whose local answer was empty while the SAOS API had results are recorded (table `discrepancies`) - that is a mirror integrity check, not query logging.
- **No content modification** - we return exactly what the SAOS API returns, with no "enhancement" / summarization. Modification = loss of evidentiary value.

## MCP tools (tools contract)

| Tool | Key parameters | Returns |
|---|---|---|
| `search` | `query`, `court_type?`, `date_from?`, `date_to?` | list of judgments with metadata + citations |
| `get_judgment` | `judgment_id` | full judgment text + metadata + citations |
| `search_by_case` | `case_number` (case signature) | all judgments for a given case number |

Full schema description: `src/index.ts` + MCP documentation in `README.md`.

## Build and test

```bash
npm install        # Node 20+
npm run build      # tsc -> dist/
npm start          # node dist/index.js (stdio transport; MCP_TRANSPORT=http -> Streamable HTTP on $PORT/mcp)
npm run sync       # node dist/sync.js - full dump download (resumable), then incremental (SAOS_DB, default /data/saos.sqlite)
npm run dev        # ts-node src/index.ts (development)
```

Manual test via the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Code rules

- **TypeScript strict**. No `any` in new code.
- **`@modelcontextprotocol/sdk` ^1.12.0** - the MCP SDK; do not change the version without checking compatibility with Patron and other clients.
- **No Polish characters in commit messages**.
- **Bump CHANGELOG.md on EVERY tool contract change** (SEMVER MAJOR).
- **No node_modules / dist in commits** (they are in `.gitignore`).

## What NOT to do (hard rules)

- **Do NOT add tools that send user data to external APIs** other than SAOS. The connector must be **single-source** (SAOS); every additional source = a separate MCP repo.
- **Do NOT modify the returned judgment text** - it is primary, integral data.
- **Do NOT cache queries containing PII** - the mirror holds public SAOS data only. Caching of client conversations happens at the client level (Patron) with a retention policy.
- **No breaking changes without a MAJOR bump** in `package.json` and CHANGELOG.

## Sources of truth (reading order)

1. [README.md](./README.md) - installation and call examples
2. [CHANGELOG.md](./CHANGELOG.md) - version history
3. `src/index.ts` - tools implementation + schema; `src/engine.ts` (local mirror first, SAOS API fallback), `src/sync.ts` (dump download)
4. [SAOS API documentation](https://saos.org.pl/help/index.php/dokumentacja-api) - upstream contract

## Agent compatibility

The [AGENTS.md](https://agents.md) standard. For Claude Code there is an additional [CLAUDE.md](./CLAUDE.md) file.

The connector is agent-agnostic (MCP) - it plugs into Claude Code, Patron, Cursor, Codex, Continue, Cline, and any protocol-compliant client.

## License

**MIT** - see [LICENSE](./LICENSE). You may embed it in any commercial / open source product without restrictions.

Citation: *MateMatic Solutions (2026), mcp-saos - MCP server for Polish SAOS case law, https://github.com/matematicsolutions/mcp-saos, MIT.*

## Deployment (fork elconcept, NAS)

`/volume2/docker/mcp-saos` = this repo. Portainer stack `mcp-saos` built from `docker-compose.yaml`; network
`cf_mcp_saos` (cloudflared + this container), no host ports, public only as https://mcp-saos.xlap.pl/mcp behind
Cloudflare Access (Managed OAuth). Data: `./data/saos.sqlite` (git-ignored). Push to `main` -> GitHub Actions ->
deploy-hook rebuilds the stack. Mirror state: `GET /status`.
