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
 *
 * The MCP protocol layer below is hand-rolled on purpose: the official SDK
 * pulls an HTTP-server dependency tree (express, hono, ajv, cross-spawn, …)
 * into a stdio-only package. A tools-only server needs exactly four verbs,
 * implemented against the line-delimited JSON-RPC 2.0 framing of the MCP
 * stdio transport — pinned by the vitest suite in test/.
 */

import {
  countTweet,
  splitThread,
  parseTweetInput,
  snowflakeToDate,
  permalinkFor,
} from "./xrules.js";

const NAME = "twittertools";
const VERSION = "1.2.0"; // keep in sync with package.json
const API_BASE = (process.env.TWITTERTOOLS_API_BASE || "https://twittertools.com").replace(/\/+$/, "");
const VIA = "https://twittertools.com";
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

// A Snowflake id encodes the creation time, so an id decoding to the future
// cannot belong to any post — X's endpoint still withholds those like
// sensitive content. Fail fast (no upstream call) with the real cause instead
// of relaying a misleading login-wall message for what is likely a typo.
function impossibleIdError(input) {
  const parsed = parseTweetInput(input);
  if (!parsed) return null;
  const created = snowflakeToDate(parsed.id);
  if (Number.isNaN(created.getTime()) || created.getTime() <= Date.now() + 60_000) return null;
  return textResult(
    `Post not found — this ID encodes a posting date in the future (${created.toISOString()}), so no post can have it. Check the number for typos.`,
    { error: true }
  );
}

async function callTool(name, args) {
  switch (name) {
    case "get_tweet": {
      const input = strArg(args, "url_or_id");
      const impossible = impossibleIdError(input);
      if (impossible) return impossible;
      const data = await callApi("tweet", { id: input });
      if (!data?.tweet) throw new Error("twittertools API returned no tweet");
      // attribution rides inside the JSON: clients that pretty-render tool
      // results would strip a trailing signature line appended after it
      return textResult(JSON.stringify({ tweet: data.tweet, via: VIA }, null, 2));
    }
    case "get_thread": {
      const input = strArg(args, "url_or_id");
      const impossible = impossibleIdError(input);
      if (impossible) return impossible;
      const data = await callApi("thread", { url: input });
      if (!data?.tweets) throw new Error("twittertools API returned no thread");
      const head = data.partial
        ? `Note: this thread result is PARTIAL (${data.reason || "incomplete"}) — posts may be missing.\n\n`
        : "";
      return textResult(head + JSON.stringify({ count: data.tweets.length, tweets: data.tweets, via: VIA }, null, 2));
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

// --------------------------------------------------------------------------- //
// Line-delimited JSON-RPC 2.0 over stdio (MCP stdio transport)                 //
// --------------------------------------------------------------------------- //

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function dispatch(msg) {
  const { method, id, params } = msg;
  const isRequest = "id" in msg;
  try {
    switch (method) {
      case "initialize":
        // echo the client's requested version: every current client accepts
        // its own, and we make no use of newer protocol features
        sendResult(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: VERSION },
        });
        return;
      case "notifications/initialized":
        return; // notification — no response
      case "tools/list":
        sendResult(id, { tools: TOOLS });
        return;
      case "tools/call":
        // tool execution failures are tool results (isError), not protocol
        // errors — matches how every client renders a failed tool call
        try {
          sendResult(id, await callTool(params?.name, params?.arguments));
        } catch (e) {
          sendResult(id, textResult(`Error: ${e?.message || String(e)}`, { error: true }));
        }
        return;
      case "ping":
        sendResult(id, {});
        return;
      default:
        // unknown notifications are silently ignored per JSON-RPC 2.0
        if (isRequest) sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isRequest) sendError(id, -32603, `Internal error: ${e?.message || String(e)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, -32700, "Parse error");
      continue;
    }
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      if (msg && typeof msg === "object" && "id" in msg) {
        sendError(msg.id, -32600, "Invalid Request");
      }
      continue;
    }
    dispatch(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
