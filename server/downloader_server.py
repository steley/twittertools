#!/usr/bin/env python3
"""
TwitterTools API server — lightweight backend for twittertools.com
====================================================================

Serves the data-hungry tools (video/image downloader, thread reader) without
requiring a paid X API plan. It uses X's free syndication endpoint (the same
one that powers embeds on publisher sites) to resolve public tweets, and
proxies media downloads straight from X's CDN without touching disk.

Endpoints
---------
GET /api/tweet?id=<id|url>     -> {"tweet": {...}}
GET /api/thread?url=<id|url>   -> {"tweets": [...], "partial": bool, "reason": str?}
GET /api/download?url=<media>&name=<filename>   -> binary stream (attachment)
GET /health                    -> "ok"

Run
---
    python3 downloader_server.py            # listens on 127.0.0.1:8787
    PORT=8787 BIND=127.0.0.1 python3 downloader_server.py

In production, nginx proxies twittertools.com/api/ to this service (see
deploy/nginx-twittertools.conf). No third-party keys required.

NOTE: the syndication endpoint is free but has no SLA. The server tries
several token algorithms (including the one react-tweet uses) and remembers
whichever works. If X changes the endpoint, only TOKEN_CANDIDATES /
fetch_syndication() need updating.
"""

import asyncio
import math
import os
import re
import time
from collections import OrderedDict, defaultdict, deque
from typing import Any, Deque, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from aiohttp import ClientError, ClientSession, ClientTimeout, web

# Env overrides exist so the service can be integration-tested against a local
# mock endpoint (see scripts/mock_test.py). Never set them in production.
SYNDICATION_URL = os.environ.get(
    "TT_SYNDICATION_URL", "https://cdn.syndication.twimg.com/tweet-result"
)
_extra_hosts = [h.strip() for h in os.environ.get("TT_MEDIA_HOSTS", "").split(",") if h.strip()]
MEDIA_HOSTS = {"pbs.twimg.com", "video.twimg.com", "ton.twimg.com"} | set(_extra_hosts)
# Optional outbound proxy, e.g. TT_PROXY=socks5h://127.0.0.1:1089 for local dev
# behind a censored network ("h" = resolve DNS on the proxy side, dodging
# poisoned answers). Production VPSes that can reach X directly leave it unset.
PROXY_URL = os.environ.get("TT_PROXY", "").strip() or None
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
TWEET_ID_RE = re.compile(r"(?:x|twitter)\.com/(?:[A-Za-z0-9_]{1,15}/status(?:es)?/)?(\d{5,25})", re.I)
BARE_ID_RE = re.compile(r"^\d{5,25}$")
TWEET_CACHE_TTL = 600          # seconds
TWEET_CACHE_SIZE = 500
THREAD_MAX_ANCESTORS = 60
SYNDICATION_TIMEOUT = ClientTimeout(total=10)

TWEET_RATE = (60, 60)          # 60 requests / 60 s per IP
DOWNLOAD_RATE = (40, 60)       # 40 downloads / 60 s per IP

# --------------------------------------------------------------------------- #
# Token computation (react-tweet style). JS:                                  #
#   ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')      #
# Number(id) rounds a 19-digit id to f64 in JS exactly like Python float(),   #
# so the computation is bit-identical.                                        #
# --------------------------------------------------------------------------- #

BASE36_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _int_to_base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = []
    while n:
        n, r = divmod(n, 36)
        digits.append(BASE36_CHARS[r])
    return "".join(reversed(digits))


def _js_number_to_base36(x: float) -> str:
    """Mimic JS Number.prototype.toString(36) closely enough for token math."""
    neg = x < 0 or (x == 0 and math.copysign(1, x) < 0)
    x = abs(x)
    int_part = int(x)
    s = _int_to_base36(int_part)
    frac = x - int_part
    if frac > 0:
        digits = []
        for _ in range(24):
            frac *= 36
            d = int(frac)
            if d > 35:
                d = 35
            digits.append(BASE36_CHARS[d])
            frac -= d
            if frac <= 0:
                break
        s += "." + "".join(digits)
    return ("-" if neg else "") + s


def candidate_tokens(tweet_id: str) -> List[str]:
    value = (float(tweet_id) / 1e15) * math.pi
    s36 = _js_number_to_base36(value)
    stripped = re.sub(r"(0+|\.)", "", s36)
    sliced = s36[2:15] if len(s36) >= 4 else s36
    tokens: List[str] = []
    for t in (stripped, sliced, "a"):
        if t and t not in tokens:
            tokens.append(t)
    return tokens


# --------------------------------------------------------------------------- #
# Caching / rate limiting                                                     #
# --------------------------------------------------------------------------- #

class TtlCache:
    def __init__(self, ttl: float, maxsize: int):
        self.ttl = ttl
        self.maxsize = maxsize
        self._data: "OrderedDict[str, Tuple[float, Any]]" = OrderedDict()

    def get(self, key: str) -> Optional[Any]:
        item = self._data.get(key)
        if not item:
            return None
        ts, value = item
        if time.monotonic() - ts > self.ttl:
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)
        return value

    def put(self, key: str, value: Any) -> None:
        self._data[key] = (time.monotonic(), value)
        self._data.move_to_end(key)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float):
        self.limit = limit
        self.window = window_seconds
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        if len(self._hits) > 20_000:  # keep the IP table bounded
            self._hits.clear()
        return True


tweet_cache = TtlCache(TWEET_CACHE_TTL, TWEET_CACHE_SIZE)
tweet_limiter = SlidingWindowLimiter(*TWEET_RATE)
download_limiter = SlidingWindowLimiter(*DOWNLOAD_RATE)
inflight: Dict[str, asyncio.Future] = {}

_token_mode_lock = asyncio.Lock()
_working_token: Optional[str] = None  # remember which candidate algorithm works


def client_ip(request: web.Request) -> str:
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote or "unknown"


def json_error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


# --------------------------------------------------------------------------- #
# Syndication fetching                                                        #
# --------------------------------------------------------------------------- #

async def _try_syndication(session: ClientSession, tweet_id: str, token: Optional[str]) -> Tuple[int, Optional[dict]]:
    params = {"id": tweet_id, "lang": "en"}
    if token is not None:
        params["token"] = token
    try:
        async with session.get(
            SYNDICATION_URL, params=params, timeout=SYNDICATION_TIMEOUT
        ) as resp:
            if resp.status != 200:
                return resp.status, None
            data = await resp.json(content_type=None)
            if isinstance(data, dict) and (data.get("id_str") or data.get("text")):
                return 200, data
            return resp.status, None
    except (ClientError, asyncio.TimeoutError):
        return 599, None


async def fetch_syndication(session: ClientSession, tweet_id: str) -> Tuple[int, Optional[dict]]:
    """Fetch one tweet from the syndication endpoint, trying token algorithms."""
    global _working_token

    tokens: List[Optional[str]] = list(candidate_tokens(tweet_id))
    if not tokens:
        tokens = ["a"]
    tokens.append(None)  # last resort: no token parameter at all

    async with _token_mode_lock:
        preferred = _working_token
    order = tokens if preferred is None else [preferred] + [t for t in tokens if t != preferred]

    saw_404 = saw_auth = False
    last_status = 0
    for token in order:
        status, data = await _try_syndication(session, tweet_id, token)
        last_status = status
        if data is not None:
            async with _token_mode_lock:
                _working_token = token
            return 200, data
        if status == 404:
            saw_404 = True
        elif status in (401, 403):
            saw_auth = True

    # A 404 on any attempt means the tweet itself doesn't exist (a valid token
    # attempt reached the tweet lookup); auth errors alone mean it's protected.
    if saw_404:
        return 404, None
    if saw_auth:
        return 401, None
    return (last_status or 502), None


# --------------------------------------------------------------------------- #
# Normalization                                                               #
# --------------------------------------------------------------------------- #

def normalize_variant(v: dict) -> dict:
    return {
        "bitrate": v.get("bitrate"),
        "contentType": v.get("content_type", "application/octet-stream"),
        "url": v.get("url", ""),
    }


def normalize_media(m: dict) -> dict:
    mtype = m.get("type", "photo")
    variants = []
    if mtype in ("video", "animated_gif"):
        info = m.get("video_info") or {}
        # Only MP4 variants are downloadable for users; drop m3u8 playlists.
        variants = [
            normalize_variant(v)
            for v in info.get("variants", [])
            if v.get("url") and v.get("content_type") == "video/mp4"
        ]
        variants.sort(key=lambda v: v["bitrate"] or 0, reverse=True)
    sizes = m.get("sizes") or {}
    orig = sizes.get("large") or {}
    return {
        "type": mtype,
        "url": m.get("media_url_https", ""),
        "width": orig.get("w"),
        "height": orig.get("h"),
        "variants": variants,
    }


def normalize_tweet(d: dict) -> dict:
    user = d.get("user") or {}
    tweet_id = d.get("id_str") or str(d.get("id", ""))
    screen = user.get("screen_name", "")
    return {
        "id": tweet_id,
        "url": f"https://x.com/{screen or 'i'}/status/{tweet_id}",
        "text": d.get("text", ""),
        "createdAt": d.get("created_at"),
        "user": {
            "name": user.get("name", ""),
            "screenName": screen,
            "avatar": user.get("profile_image_url_https", ""),
        },
        "media": [normalize_media(m) for m in (d.get("mediaDetails") or [])],
        "likes": d.get("favorite_count"),
        "replies": d.get("conversation_count"),
        "replyToId": d.get("in_reply_to_status_id_str"),
        "quoted": normalize_tweet(d["quoted_tweet"]) if d.get("quoted_tweet") else None,
    }


def parse_tweet_id(raw: str) -> Optional[str]:
    raw = (raw or "").strip()
    if BARE_ID_RE.match(raw):
        return raw
    m = TWEET_ID_RE.search(raw)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- #
# Handlers                                                                    #
# --------------------------------------------------------------------------- #

async def api_tweet(request: web.Request) -> web.Response:
    if not tweet_limiter.allow(client_ip(request)):
        return json_error(429, "Too many requests, please slow down.")

    tweet_id = parse_tweet_id(request.query.get("id") or request.query.get("url") or "")
    if not tweet_id:
        return json_error(400, "Provide a post URL or ID, e.g. /api/tweet?id=1234567890")

    cached = tweet_cache.get(tweet_id)
    if cached is not None:
        return web.json_response({"tweet": cached, "cached": True})

    fut = inflight.get(tweet_id)
    if fut is None:
        fut = asyncio.get_event_loop().create_future()
        inflight[tweet_id] = fut
        try:
            status, data = await fetch_syndication(
                request.app["client_session"], tweet_id
            )
        except Exception:
            status, data = 502, None

        tweet = None
        if data is not None:
            try:
                tweet = normalize_tweet(data)
                tweet_cache.put(tweet_id, tweet)
            except Exception:
                status, tweet = 502, None
        # Resolve waiters first, then free the slot: a request arriving in
        # between still awaits this future instead of re-fetching upstream.
        fut.set_result(("ok", tweet) if tweet is not None else ("error", status))
        inflight.pop(tweet_id, None)

        if tweet is not None:
            return web.json_response({"tweet": tweet})
    else:
        kind, payload = await fut
        if kind == "ok":
            return web.json_response({"tweet": payload, "cached": True})
        status = payload

    if status == 404:
        return json_error(404, "Post not found — it may be deleted, protected, or the link is wrong.")
    if status in (401, 403):
        return json_error(403, "This post is not available for embedding (likely protected).")
    return json_error(502, "Could not fetch the post from X right now. Please try again.")


async def api_thread(request: web.Request) -> web.Response:
    if not tweet_limiter.allow(client_ip(request)):
        return json_error(429, "Too many requests, please slow down.")

    tweet_id = parse_tweet_id(request.query.get("url") or request.query.get("id") or "")
    if not tweet_id:
        return json_error(400, "Provide a post URL or ID, e.g. /api/thread?url=https://x.com/user/status/1")

    tweets: List[dict] = []
    partial = False
    reason: Optional[str] = None
    seen = set()
    current = tweet_id

    session = request.app["client_session"]
    for _ in range(THREAD_MAX_ANCESTORS + 1):
        if current in seen:
            break
        seen.add(current)

        status, data = await fetch_syndication(session, current)
        if data is None:
            if tweets:
                partial = True
                reason = f"chain_interrupted_{status}"
            break

        tweet = normalize_tweet(data)
        tweets.append(tweet)
        parent = tweet.get("replyToId")
        if not parent:
            break
        current = parent
        await asyncio.sleep(0.15)  # be polite to the free endpoint

    if not tweets:
        return json_error(404, "Post not found — it may be deleted, protected, or the link is wrong.")

    tweets.sort(key=lambda t: int(t["id"] or 0))
    # If the chain walked upward but never found a self-thread parent structure,
    # a single tweet is still a valid (non-partial) response for a lone post.
    return web.json_response({"tweets": tweets, "partial": partial, "reason": reason})


def _safe_filename(name: str, url: str, content_type: str) -> str:
    candidate = (name or "").strip()
    if not candidate:
        try:
            candidate = url.split("?")[0].rstrip("/").split("/")[-1] or "media"
        except Exception:
            candidate = "media"
    candidate = re.sub(r"[^A-Za-z0-9._-]+", "-", candidate).strip(".-")
    if not candidate or candidate.startswith("."):
        candidate = "media"
    if "." not in candidate:
        ext = {
            "video/mp4": "mp4",
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "application/x-mpegURL": "mp4",
        }.get(content_type.split(";")[0].strip(), "bin")
        candidate += "." + ext
    return candidate[:120]


async def api_download(request: web.Request) -> web.StreamResponse:
    if not download_limiter.allow(client_ip(request)):
        return json_error(429, "Too many downloads, please slow down.")

    media_url = (request.query.get("url") or "").strip()
    parsed = urlparse(media_url)
    https_ok = parsed.scheme == "https"
    dev_http_ok = parsed.scheme == "http" and bool(_extra_hosts)  # only set via TT_MEDIA_HOSTS in tests
    if parsed.hostname not in MEDIA_HOSTS or not (https_ok or dev_http_ok):
        return json_error(400, "Only twittertools media hosts (pbs.twimg.com / video.twimg.com) are allowed.")

    want_name = request.query.get("name") or ""

    timeout = ClientTimeout(total=None, connect=10, sock_read=30)
    try:
        session = request.app["client_session"]
        async with session.get(media_url, timeout=timeout, headers={"User-Agent": USER_AGENT}) as upstream:
            if upstream.status != 200:
                return json_error(502, f"Media fetch failed ({upstream.status}).")
            content_type = upstream.headers.get("Content-Type", "application/octet-stream")
            filename = _safe_filename(want_name, media_url, content_type)
            resp = web.StreamResponse(
                status=200,
                headers={
                    "Content-Type": content_type,
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Cache-Control": "no-store",
                    # Set here, not in the CORS middleware: streaming responses
                    # flush their headers at prepare(), before the middleware
                    # can touch them.
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length",
                },
            )
            length = upstream.headers.get("Content-Length")
            if length:
                resp.content_length = int(length)
            await resp.prepare(request)
            async for chunk in upstream.content.iter_chunked(64 * 1024):
                await resp.write(chunk)
            await resp.write_eof()
            return resp
    except (ClientError, asyncio.TimeoutError):
        return json_error(502, "Media fetch failed — upstream connection error.")


async def health(request: web.Request) -> web.Response:
    return web.Response(text="ok")


# --------------------------------------------------------------------------- #
# App wiring                                                                  #
# --------------------------------------------------------------------------- #

@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            },
        )
    resp = await handler(request)
    resp.headers.setdefault("Access-Control-Allow-Origin", "*")
    return resp


async def not_found(request: web.Request) -> web.Response:
    return json_error(404, "Unknown API route.")


def make_session(**kwargs) -> ClientSession:
    """ClientSession with optional SOCKS/HTTP proxy support (TT_PROXY)."""
    if PROXY_URL:
        from aiohttp_socks import ProxyConnector

        url = PROXY_URL
        rdns = False
        # python_socks rejects the "socks5h" scheme; it's expressed as rdns=True
        if url.startswith("socks5h://"):
            url, rdns = "socks5://" + url[len("socks5h://"):], True
        kwargs.setdefault("connector", ProxyConnector.from_url(url, rdns=rdns))
    return ClientSession(**kwargs)


async def on_startup(app: web.Application) -> None:
    # NOTE: no Referer header here — video.twimg.com 403s requests carrying a
    # non-X Referer (hotlink protection), and the syndication endpoint works
    # without one.
    app["client_session"] = make_session(headers={"User-Agent": USER_AGENT})


def create_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app.on_startup.append(on_startup)
    app.router.add_get("/api/tweet", api_tweet)
    app.router.add_get("/api/thread", api_thread)
    app.router.add_get("/api/download", api_download)
    app.router.add_get("/health", health)
    app.router.add_route("*", "/api/{tail:.*}", not_found)
    return app


async def on_cleanup(app: web.Application) -> None:
    await app["client_session"].close()


def main() -> None:
    app = create_app()
    app.on_cleanup.append(on_cleanup)
    port = int(os.environ.get("PORT", "8787"))
    bind = os.environ.get("BIND", "127.0.0.1")
    print(f"TwitterTools API listening on http://{bind}:{port}")
    web.run_app(app, host=bind, port=port, print=None)


if __name__ == "__main__":
    main()
