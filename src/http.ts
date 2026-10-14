/**
 * HTTP helper for the SAOS API (no external deps except the optional SOCKS agent).
 *
 * Retries: attempt 1 goes direct; when SAOS_TOR_PROXY is set (e.g.
 * socks5h://127.0.0.1:9050, Tor started by start.sh) every retry goes through
 * Tor with random credentials = a fresh circuit = a new exit IP. Helps when the
 * shared CGNAT address gets throttled by SAOS.
 */

import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";

export const SAOS_BASE = "https://www.saos.org.pl/api";
const USER_AGENT = "MateMatic-MCP-SAOS/1.0 (+https://matematic.co)";

export interface FetchOptions {
  timeoutMs?: number;
  attempts?: number;
}

async function torAgent(): Promise<http.Agent | undefined> {
  const proxy = process.env.SAOS_TOR_PROXY;
  if (!proxy) return undefined;
  const u = new URL(proxy);
  u.username = randomBytes(6).toString("hex");
  u.password = randomBytes(6).toString("hex");
  // socks-proxy-agent is ESM-only; this package compiles to CommonJS.
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  return new SocksProxyAgent(u.toString());
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/** Structured upstream fault - returned to MCP clients, never as empty results. */
export interface UpstreamFault {
  code: "not_found" | "invalid_arg" | "upstream_error";
  /** caller = bad tool argument, upstream = SAOS side, network = transport */
  fault: "caller" | "upstream" | "network";
  retryable: boolean;
  status?: number;
  retryAfterS?: number;
}

/** Map an HTTP failure to a structured fault (cf. upstream 1.3.1 saos-http.ts). */
export function classifyHttpError(err: unknown): UpstreamFault {
  if (err instanceof HttpError) {
    if (err.status === 404)
      return { code: "not_found", fault: "upstream", retryable: false, status: 404 };
    if (err.status === 400)
      return { code: "invalid_arg", fault: "caller", retryable: false, status: 400 };
    if (err.status === 401 || err.status === 403)
      return { code: "upstream_error", fault: "upstream", retryable: false, status: err.status };
    if (err.status === 429)
      return {
        code: "upstream_error",
        fault: "upstream",
        retryable: true,
        status: 429,
        ...(err.retryAfterS !== undefined ? { retryAfterS: err.retryAfterS } : {}),
      };
    if (err.status >= 500)
      return { code: "upstream_error", fault: "upstream", retryable: true, status: err.status };
    return { code: "upstream_error", fault: "upstream", retryable: false, status: err.status };
  }
  return { code: "upstream_error", fault: "network", retryable: true };
}

function parseRetryAfter(headers: Record<string, string | string[] | undefined>): number | undefined {
  const v = headers["retry-after"];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return Math.min(600, Math.floor(n));
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.min(600, Math.floor((t - Date.now()) / 1000)));
  return undefined;
}

function fetchOnce(urlStr: string, timeoutMs: number, agent?: http.Agent): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const transport = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      timeout: timeoutMs,
      ...(agent && { agent }),
    };

    const req = transport.get(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(
            new HttpError(
              `HTTP ${res.statusCode}: ${body.slice(0, 300)}`,
              res.statusCode ?? 0,
              parseRetryAfter(res.headers as Record<string, string | string[] | undefined>),
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON response from SAOS: ${body.slice(0, 200)}`));
        }
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to SAOS API timed out after ${Math.round(timeoutMs / 1000)}s`));
    });

    req.on("error", (err: Error) => reject(err));
  });
}

export async function fetchJson(urlStr: string, opts: FetchOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 40000;
  const attempts = Math.max(1, opts.attempts ?? 1);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchOnce(urlStr, timeoutMs, i > 0 ? await torAgent() : undefined);
    } catch (err) {
      lastErr = err;
      // 401/403 = access control by the source: NEVER rotate exit IP to work
      // around it (F memo, sec. 5). No retry at all.
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw err;
      }
      // 4xx other than 403/429 = bad request / not found - retrying will not help.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 403 && err.status !== 429) {
        throw err;
      }
      if (i < attempts - 1) {
        // 429: honour Retry-After instead of the exponential default.
        const wait =
          err instanceof HttpError && err.status === 429 && err.retryAfterS !== undefined
            ? Math.min(600000, err.retryAfterS * 1000)
            : Math.min(60000, 2000 * 2 ** i);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404;
}
