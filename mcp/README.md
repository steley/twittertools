# twittertools-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for
[TwitterTools](https://twittertools.com) — brings the toolkit to AI agents
(Claude, ChatGPT, Cursor, ZCode, …). No login, no tracking, no API keys.
Listed in the official MCP Registry as `io.github.steley/twittertools-mcp`.

## Tools

| Tool | What it does |
| --- | --- |
| `get_tweet` | Fetch a public post by URL or ID: text, author, media with direct CDN URLs |
| `get_thread` | Unroll a thread into its posts, in order (partial results are flagged) |
| `count_chars` | Measure text against X's real 280-character limit (CJK ×2, links = 23) |
| `split_thread` | Split long text into numbered, limit-fitting posts |
| `parse_tweet_url` | URL/ID → ID, author handle, posting time, canonical permalink |

`get_tweet` / `get_thread` call the stateless [twittertools.com](https://twittertools.com)
API, which resolves public posts through X's free syndication endpoint. The other
three run entirely offline. Media is **not** proxied: tweet results carry the
direct `pbs.twimg.com` / `video.twimg.com` URLs, which any client can fetch on its own.

## Install

```sh
# Claude Code
claude mcp add twittertools -- npx -y twittertools-mcp
```

Or add it to any client that reads an `mcpServers` config
(Claude Desktop's `claude_desktop_config.json`, Cursor's `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "twittertools": {
      "command": "npx",
      "args": ["-y", "twittertools-mcp"]
    }
  }
}
```

Requires Node 18+.

## Self-hosting

Point `TWITTERTOOLS_API_BASE` at your own instance of
[`server/downloader_server.py`](../server/) to keep lookups entirely on your
infrastructure:

```json
{ "command": "npx", "args": ["-y", "twittertools-mcp"], "env": { "TWITTERTOOLS_API_BASE": "https://your-instance.example" } }
```

## Privacy

The server is stateless: nothing is stored, no telemetry, no accounts. It talks
only to the configured API base. The API itself is rate-limited per IP and keeps
only aggregate, anonymous counters — see [twittertools.com/privacy](https://twittertools.com/privacy).

## Development

```sh
npm install
cd .. && npx vitest run mcp   # unit + stdio protocol tests (offline, mock API)
```

MIT — same as the [main project](https://github.com/steley/twittertools).
