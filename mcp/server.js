#!/usr/bin/env node
/**
 * TwitterTools MCP server (stdio) — brings twittertools.com to AI agents.
 *
 * Tools backed by the public API (stateless, no keys, rate-limited per IP):
 *   get_tweet    -> GET {base}/api/tweet?id=...
 *   get_thread   -> GET {base}/api/thread?url=...
 * Local tools (offline, same engine as the website):
 *   count_chars, split_thread, parse_tweet_url
 *
 * Media is NOT proxied through the API here: get_tweet results carry the
 * direct pbs.twimg.com / video.twimg.com URLs, which any client can fetch.
 *
 * Set TWITTERTOOLS_API_BASE to point at a self-hosted instance.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  countTweet,
  splitThread,
  parseTweetInput,
  snowflakeToDate,
  permalinkFor,
} from "./xrules.js";

const NAME = "twittertools";
const VERSION = "1.0.2"; // keep in sync with package.json
const API_BASE = (process.env.TWITTERTOOLS_API_BASE || "https://twittertools.com").replace(/\/+$/, "");
const ATTRIBUTION = "\n\nvia twittertools.com";
const TEXT_INPUT_MAX = 100_000; // generous, but caps local work per call

const urlOrIdSchema = {
  type: "object",
  properties: {
    url_or_id: {
      type: "string",
      description: "Post URL (x.com or twitter.com), bare numeric ID, or text containing one",
    },
  },
  required: ["url_or_id"],
};

const TOOLS = [
  {
    name: "get_tweet",
    description:
      "Fetch one public X (Twitter) post by URL or ID: text, author, engagement counts, " +
      "and media with direct CDN URLs (photos, or MP4 video variants sorted by quality). " +
      "Deleted, protected, or age-restricted posts are not available without an X login.",
    inputSchema: urlOrIdSchema,
  },
  {
    name: "get_thread",
    description:
      "Unroll a public X thread into its posts in order. Expensive upstream — call sparingly, " +
      "and prefer pasting the thread's LAST post, which returns the whole chain. Results may " +
      "be partial; the response says so when they are.",
    inputSchema: urlOrIdSchema,
  },
  {
    name: "count_chars",
    description:
      "Count text against X's real 280-character limit: CJK and emoji weigh 2, any link " +
      "weighs exactly 23. Same engine as twittertools.com/tweet-character-counter/.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to measure" },
      },
      required: ["text"],
    },
  },
  {
    name: "split_thread",
    description:
      "Split long text into numbered posts (1/, 2/, …) that each fit X's 280 weighted-character " +
      "limit, preferring sentence boundaries and never breaking a URL. Same engine as " +
      "twittertools.com/tweet-splitter/.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to split" },
        numbering: { type: "boolean", description: "Prefix each post with 'n/ ' (default true)" },
      },
      required: ["text"],
    },
  },
  {
    name: "parse_tweet_url",
    description:
      "Parse a post URL, bare ID, or free text containing an ID: returns the numeric ID, " +
      "author handle, posting timestamp (decoded from the Snowflake ID), and canonical permalink. Offline.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "URL, ID, or text containing either" },
      },
      required: ["input"],
    },
  },
];

function textResult(text, { error = false } = {}) {
  return { content: [{ type: "text", text }], isError: error };
}

function strArg(args, field, max = 2000) {
  const v = args?.[field];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Missing required argument: ${field} (string)`);
  }
  if (v.length > max) {
    throw new Error(`${field} is too long (max ${max} characters)`);
  }
  return v;
}

async function callApi(endpoint, params) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/${endpoint}?${new URLSearchParams(params)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new Error(
      timedOut
        ? `twittertools API timed out after 20s (${API_BASE})`
        : `twittertools API unreachable (${API_BASE}) — check the network or TWITTERTOOLS_API_BASE`
    );
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body (proxy error page, HTML) — fall through to the status message
  }
  if (!res.ok) {
    throw new Error(body?.error || `twittertools API returned HTTP ${res.status}`);
  }
  return body;
}

async function callTool(name, args) {
  switch (name) {
    case "get_tweet": {
      const data = await callApi("tweet", { id: strArg(args, "url_or_id") });
      if (!data?.tweet) throw new Error("twittertools API returned no tweet");
      return textResult(JSON.stringify(data.tweet, null, 2) + ATTRIBUTION);
    }
    case "get_thread": {
      const data = await callApi("thread", { url: strArg(args, "url_or_id") });
      if (!data?.tweets) throw new Error("twittertools API returned no thread");
      const head = data?.partial
        ? `Note: this thread result is PARTIAL (${data.reason || "incomplete"}) — posts may be missing.\n\n`
        : "";
      return textResult(head + JSON.stringify({ count: data.tweets.length, tweets: data.tweets }, null, 2) + ATTRIBUTION);
    }
    case "count_chars":
      return textResult(JSON.stringify(countTweet(strArg(args, "text", TEXT_INPUT_MAX)), null, 2));
    case "split_thread": {
      const numbering = args?.numbering !== false;
      const posts = splitThread(strArg(args, "text", TEXT_INPUT_MAX), numbering);
      return textResult(JSON.stringify({ count: posts.length, posts }, null, 2));
    }
    case "parse_tweet_url": {
      const parsed = parseTweetInput(strArg(args, "input"));
      if (!parsed) {
        return textResult("No post URL or ID found in the input.", { error: true });
      }
      const created = snowflakeToDate(parsed.id);
      return textResult(
        JSON.stringify(
          {
            id: parsed.id,
            screenName: parsed.screenName,
            createdAt: Number.isNaN(created.getTime()) ? null : created.toISOString(),
            permalink: permalinkFor(parsed.id, parsed.screenName),
          },
          null,
          2
        )
      );
    }
    default:
      return textResult(`Unknown tool: ${name}`, { error: true });
  }
}

const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callTool(name, args);
  } catch (e) {
    return textResult(`Error: ${e?.message || String(e)}`, { error: true });
  }
});

await server.connect(new StdioServerTransport());
