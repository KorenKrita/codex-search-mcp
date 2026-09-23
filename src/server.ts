#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

type SearchResult = {
  type?: string;
  ref_id?: string;
  url?: string;
  title?: string;
  snippet?: string;
  domain?: string;
};

type SearchResponse = {
  output?: string;
  results: SearchResult[];
};

type Credentials = {
  accessToken: string;
  accountId?: string;
};

type ResearchInput = {
  session_id?: string;
  search_query?: Array<{ q: string; recency?: number; domains?: string[] }>;
  open?: Array<{ ref_id: string; lineno?: number }>;
  click?: Array<{ ref_id: string; id: number }>;
  find?: Array<{ ref_id: string; pattern: string }>;
  response_length?: "short" | "medium" | "long";
};

const searchResultSchema = z.object({
  type: z.string().optional(),
  ref_id: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  domain: z.string().optional(),
});

const outputSchema = {
  sessionId: z.string(),
  output: z.string().optional(),
  results: z.array(searchResultSchema),
};

function loadCredentials(): Credentials {
  if (process.env.CODEX_ACCESS_TOKEN) {
    return {
      accessToken: process.env.CODEX_ACCESS_TOKEN,
      accountId: process.env.CODEX_ACCOUNT_ID || undefined,
    };
  }

  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const accessToken = parsed?.tokens?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) throw new Error();
    const accountId = parsed?.tokens?.account_id;
    return {
      accessToken,
      accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
    };
  } catch {
    throw new Error(
      "Codex authentication is unavailable. Set CODEX_ACCESS_TOKEN (and optionally CODEX_ACCOUNT_ID), or run codex login on this Mac.",
    );
  }
}

function normalizeResponse(body: unknown): SearchResponse {
  if (!body || typeof body !== "object") return { results: [] };
  const value = body as Record<string, unknown>;
  const results = Array.isArray(value.results)
    ? value.results.flatMap((item): SearchResult[] => {
        if (!item || typeof item !== "object") return [];
        const source = item as Record<string, unknown>;
        const result: SearchResult = {};
        for (const key of ["type", "ref_id", "url", "title", "snippet", "domain"] as const) {
          if (typeof source[key] === "string" && source[key].trim()) result[key] = source[key].trim();
        }
        return Object.keys(result).length > 0 ? [result] : [];
      })
    : [];
  return {
    ...(typeof value.output === "string" ? { output: value.output } : {}),
    results,
  };
}

function formatText(response: SearchResponse): string {
  if (response.output?.trim()) return response.output.trim();
  if (response.results.length === 0) return "No output or structured web results returned.";
  return response.results
    .map((result, index) => {
      const title = result.title || result.url || `Result ${index + 1}`;
      return [`[${index + 1}] ${title}`, result.url, result.snippet].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function validateResearchInput(input: ResearchInput): void {
  const hasSearch = Boolean(input.search_query?.length);
  const hasFollowUp = Boolean(input.open?.length || input.click?.length || input.find?.length);
  if (!hasSearch && !hasFollowUp) {
    throw new Error("At least one search_query, open, click, or find operation is required.");
  }
  if (hasFollowUp && !hasSearch && !input.session_id) {
    throw new Error("session_id is required for follow-up open, click, or find operations.");
  }
}

async function executeSearch(
  commands: Omit<ResearchInput, "session_id">,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const credentials = loadCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), DEFAULT_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "codex-cli/0.147.0-alpha.6.5",
  };
  if (credentials.accountId) headers["ChatGPT-Account-ID"] = credentials.accountId;

  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: sessionId, model: "gpt-4o", commands }),
        signal: controller.signal,
      });
      if (![502, 503, 504].includes(response.status) || attempt === MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }

    if (!response) throw new Error("No response received from Codex search.");
    if (response.status === 401 || response.status === 403) throw new Error("Codex authentication expired or was rejected.");
    if (response.status === 429) throw new Error("Codex search rate limit exceeded.");
    if (!response.ok) throw new Error(`Codex search returned HTTP ${response.status}.`);
    return normalizeResponse(await response.json());
  } catch (error) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new Error("Codex search was cancelled.");
      throw new Error(`Codex search timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function toolResult(sessionId: string, response: SearchResponse) {
  return {
    content: [{ type: "text" as const, text: formatText(response) }],
    structuredContent: {
      sessionId,
      ...(response.output === undefined ? {} : { output: response.output }),
      results: response.results,
    },
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "codex-search", version: "1.0.0" });

  server.registerTool(
    "codex_search",
    {
      title: "Codex Search",
      description: "Search the live web with OpenAI Codex standalone search. This performs retrieval only; it does not run a Codex agent turn.",
      inputSchema: {
        query: z.string().min(1),
        recency: z.number().nonnegative().optional(),
        domains: z.array(z.string().min(1)).optional(),
        response_length: z.enum(["short", "medium", "long"]).default("short"),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, recency, domains, response_length }, context) => {
      const sessionId = `search_${randomUUID()}`;
      const response = await executeSearch(
        { search_query: [{ q: query, ...(recency === undefined ? {} : { recency }), ...(domains ? { domains } : {}) }], response_length },
        sessionId,
        context.signal,
      );
      return toolResult(sessionId, response);
    },
  );

  server.registerTool(
    "codex_research",
    {
      title: "Codex Research",
      description: "Run live multi-step Codex web research. Start with search_query, then pass the returned sessionId as session_id for open, click, or find follow-ups.",
      inputSchema: {
        session_id: z.string().min(1).optional(),
        search_query: z.array(z.object({
          q: z.string().min(1),
          recency: z.number().nonnegative().optional(),
          domains: z.array(z.string().min(1)).optional(),
        })).optional(),
        open: z.array(z.object({ ref_id: z.string().min(1), lineno: z.number().optional() })).optional(),
        click: z.array(z.object({ ref_id: z.string().min(1), id: z.number() })).optional(),
        find: z.array(z.object({ ref_id: z.string().min(1), pattern: z.string() })).optional(),
        response_length: z.enum(["short", "medium", "long"]).default("long"),
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input, context) => {
      validateResearchInput(input);
      const sessionId = input.session_id || `research_${randomUUID()}`;
      const { session_id: _sessionId, ...commands } = input;
      const response = await executeSearch(commands, sessionId, context.signal);
      return toolResult(sessionId, response);
    },
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

export const testables = { normalizeResponse, formatText, validateResearchInput };
