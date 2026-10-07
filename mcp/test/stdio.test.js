import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(here, '..', 'server.js');

// Fixture shaped like the API's normalized tweet (server/downloader_server.py
// normalize_tweet) — id 1500000000000000000, screenName "user".
const TWEET = {
  id: '1500000000000000000',
  url: 'https://x.com/user/status/1500000000000000000',
  text: 'hello from the mock',
  createdAt: 'Sun Mar 13 06:47:23 +0000 2022',
  user: { name: 'User', screenName: 'user', avatar: 'https://pbs.twimg.com/profile.png' },
  media: [
    {
      type: 'photo',
      url: 'https://pbs.twimg.com/media/mock.jpg',
      width: 100,
      height: 100,
      durationMs: null,
      variants: [],
    },
  ],
  likes: 1,
  replies: 0,
  replyToId: null,
  article: false,
  quoted: null,
};

let mockApi;
let mockPort;
let proc;
let client;

class StdioClient {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.next = 1;
    this.pending = new Map();
    child.stdout.on('data', (d) => this._onData(d));
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

beforeAll(async () => {
  mockApi = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/tweet') {
      // the real API accepts a URL or bare id and extracts it server-side
      const id = (url.searchParams.get('id') || '').match(/(\d{5,25})$/)?.[1];
      if (id === '1500000000000000000') {
        res.end(JSON.stringify({ tweet: TWEET }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Post not found — it may be deleted, protected, or the link is wrong.' }));
      }
      return;
    }
    if (url.pathname === '/api/thread') {
      res.end(JSON.stringify({ tweets: [TWEET], partial: true, reason: 'chain_interrupted_599' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Unknown API route.' }));
  });
  await new Promise((resolve) => mockApi.listen(0, '127.0.0.1', resolve));
  mockPort = mockApi.address().port;

  proc = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, TWITTERTOOLS_API_BASE: `http://127.0.0.1:${mockPort}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  client = new StdioClient(proc);
  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' },
  });
  expect(init.result.serverInfo.name).toBe('twittertools');
  client.notify('notifications/initialized', {});
});

afterAll(async () => {
  proc?.kill();
  await new Promise((resolve) => mockApi.close(resolve));
});

describe('twittertools MCP server (stdio)', () => {
  it('lists the five tools', async () => {
    const res = await client.request('tools/list', {});
    expect(res.result.tools.map((t) => t.name)).toEqual([
      'get_tweet',
      'get_thread',
      'count_chars',
      'split_thread',
      'parse_tweet_url',
    ]);
  });

  it('get_tweet returns the tweet text and attribution', async () => {
    const res = await client.request('tools/call', {
      name: 'get_tweet',
      arguments: { url_or_id: 'https://x.com/user/status/1500000000000000000' },
    });
    expect(res.result.isError).toBeFalsy();
    const text = res.result.content[0].text;
    expect(text).toContain('hello from the mock');
    expect(text).toContain('pbs.twimg.com/media/mock.jpg');
    expect(text).toContain('via twittertools.com');
  });

  it('get_tweet surfaces the API error for a missing post', async () => {
    const res = await client.request('tools/call', {
      name: 'get_tweet',
      arguments: { url_or_id: '999' },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Post not found');
  });

  it('get_thread flags partial results', async () => {
    const res = await client.request('tools/call', {
      name: 'get_thread',
      arguments: { url_or_id: '1500000000000000000' },
    });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toContain('PARTIAL');
    expect(res.result.content[0].text).toContain('chain_interrupted_599');
  });

  it('count_chars measures CJK as double weight', async () => {
    const res = await client.request('tools/call', {
      name: 'count_chars',
      arguments: { text: '你好' },
    });
    expect(JSON.parse(res.result.content[0].text).weightedLength).toBe(4);
  });

  it('split_thread numbers posts by default and honours numbering:false', async () => {
    const numbered = await client.request('tools/call', {
      name: 'split_thread',
      arguments: { text: 'Hello world' },
    });
    expect(JSON.parse(numbered.result.content[0].text)).toEqual({ count: 1, posts: ['1/ Hello world'] });

    const plain = await client.request('tools/call', {
      name: 'split_thread',
      arguments: { text: 'Hello world', numbering: false },
    });
    expect(JSON.parse(plain.result.content[0].text)).toEqual({ count: 1, posts: ['Hello world'] });
  });

  it('parse_tweet_url decodes the snowflake timestamp offline', async () => {
    const res = await client.request('tools/call', {
      name: 'parse_tweet_url',
      arguments: { input: 'https://x.com/user/status/1500000000000000000' },
    });
    expect(JSON.parse(res.result.content[0].text)).toEqual({
      id: '1500000000000000000',
      screenName: 'user',
      createdAt: '2022-03-05T06:47:23.309Z',
      permalink: 'https://x.com/user/status/1500000000000000000',
    });
  });

  it('rejects missing arguments with a tool error', async () => {
    const res = await client.request('tools/call', { name: 'get_tweet', arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('url_or_id');
  });

  it('answers ping with an empty result', async () => {
    const res = await client.request('ping', {});
    expect(res.result).toEqual({});
  });

  it('returns method-not-found for unknown requests', async () => {
    const res = await client.request('resources/list', {});
    expect(res.error).toEqual({ code: -32601, message: expect.stringContaining('resources/list') });
  });

  it('survives malformed lines and unknown notifications', async () => {
    client.child.stdin.write('this is not json\n');
    client.notify('some/unknown/notification', {});
    // the server must keep serving after both
    const res = await client.request('ping', {});
    expect(res.result).toEqual({});
  });
});
