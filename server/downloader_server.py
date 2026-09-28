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
import json
import math
import os
import re
import time
from contextlib import suppress
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

# Origins allowed to call the API cross-origin. The production site is
# same-origin (Apache proxies /api/) and needs no CORS header; the localhost
# entries exist so `astro dev` can talk to a locally running API. Other
# websites don't get to embed our API in their pages.
ALLOWED_ORIGINS = {
    o.strip()
    for o in os.environ.get(
        "TT_ALLOWED_ORIGINS",
        "https://twittertools.com,https://www.twittertools.com,"
        "http://localhost:4321,http://127.0.0.1:4321",
    ).split(",")
    if o.strip()
}

# Long ("note") posts: the syndication endpoint only returns a teaser (its
# note_tweet field carries an ID but no body). X's web GraphQL endpoint,
# called with the anonymous guest token every browser receives, still returns
# the full text. Free, keyless, no login — same trick fxtwitter uses. Any
# failure degrades gracefully to the teaser text.
GRAPHQL_QUERY_ID = os.environ.get("TT_GRAPHQL_QUERY_ID", "0hWvDhmW8YQ-S_ib3azIrw")
GUEST_API_ENABLED = os.environ.get("TT_GUEST_API", "1") != "0"
# Overridable so the mock suite can exercise the whole note-tweet fallback
# against a local fake (never set in production).
GUEST_ACTIVATE_URL = os.environ.get("TT_GUEST_ACTIVATE_URL", "https://api.x.com/1.1/guest/activate.json")
GRAPHQL_BASE = os.environ.get("TT_GRAPHQL_BASE", "https://x.com/i/api/graphql")
WEB_BEARER_TOKEN = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs="
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)
GRAPHQL_TIMEOUT = ClientTimeout(total=12)
GRAPHQL_COOLDOWN = 300.0        # seconds to back off after a guest-API failure
_guest_token: Optional[str] = None
_guest_cooldown_until = 0.0

GRAPHQL_FEATURES = {
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "responsive_web_home_pinned_timelines_enabled": True,
    "creator_subscriptions_quote_tweet_preview_enabled": False,
    "fetch_translast_enabled": False,
    "super_follow_badge_privacy_enabled": False,
    "super_follow_user_api_enabled": False,
    "super_follow_tweet_api_enabled": False,
    "rweb_tipjar_consumption_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
}
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
    # Cloudflare sets CF-Connecting-IP from the actual TCP peer, so behind
    # the CF proxy this is the only trustworthy per-client key; a client
    # can freely set X-Forwarded-For, which is why nginx overwrites it and
    # why it is only a fallback here.
    cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
    if cf_ip:
        return cf_ip
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
            data = await enrich_note_tweet(session, tweet_id, data)
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
# Guest GraphQL fallback (full text for long "note" posts)                     #
# --------------------------------------------------------------------------- #

async def get_guest_token(session: ClientSession, force: bool = False) -> Optional[str]:
    """Anonymous web guest token — X issues one to every browser for free."""
    global _guest_token
    async with _token_mode_lock:
        if _guest_token and not force:
            return _guest_token
        try:
            async with session.post(
                GUEST_ACTIVATE_URL,
                headers={"Authorization": f"Bearer {WEB_BEARER_TOKEN}"},
                timeout=GRAPHQL_TIMEOUT,
            ) as resp:
                if resp.status == 200:
                    data = await resp.json(content_type=None)
                    if data.get("guest_token"):
                        _guest_token = str(data["guest_token"])
        except (ClientError, asyncio.TimeoutError):
            pass
        return _guest_token


async def _query_tweet_result(session: ClientSession, tweet_id: str, token: str) -> Tuple[int, Optional[dict]]:
    variables = {
        "tweetId": tweet_id,
        "withCommunity": False,
        "includePromotedContent": False,
        "withVoice": False,
    }
    params = {
        "variables": json.dumps(variables, separators=(",", ":")),
        "features": json.dumps(GRAPHQL_FEATURES, separators=(",", ":")),
    }
    headers = {
        "Authorization": f"Bearer {WEB_BEARER_TOKEN}",
        "x-guest-token": token,
    }
    try:
        async with session.get(
            f"{GRAPHQL_BASE}/{GRAPHQL_QUERY_ID}/TweetResultByRestId",
            params=params, headers=headers, timeout=GRAPHQL_TIMEOUT,
        ) as resp:
            if resp.status != 200:
                return resp.status, None
            data = await resp.json(content_type=None)
            result = ((data.get("data") or {}).get("tweetResult") or {}).get("result") or {}
            return 200, result
    except (ClientError, asyncio.TimeoutError):
        return 599, None


async def fetch_note_tweet(session: ClientSession, tweet_id: str) -> Optional[dict]:
    """Full note-tweet result {text, entity_set} from the guest API, or None."""
    global _guest_cooldown_until
    if not GUEST_API_ENABLED or time.time() < _guest_cooldown_until:
        return None
    token = await get_guest_token(session)
    if not token:
        _guest_cooldown_until = time.time() + GRAPHQL_COOLDOWN
        return None
    status, result = await _query_tweet_result(session, tweet_id, token)
    if status in (401, 403, 429) and token:  # stale or rate-limited guest token
        token = await get_guest_token(session, force=True)
        if token:
            status, result = await _query_tweet_result(session, tweet_id, token)
    if status != 200 or not result:
        _guest_cooldown_until = time.time() + GRAPHQL_COOLDOWN
        return None
    note = ((result.get("note_tweet") or {}).get("note_tweet_results") or {}).get("result") or {}
    return note if note.get("text") else None


async def enrich_note_tweet(session: ClientSession, tweet_id: str, data: dict) -> dict:
    """Swap the syndication teaser for the full note body when one exists."""
    if not data.get("note_tweet"):
        return data
    note = await fetch_note_tweet(session, tweet_id)
    if not note:
        return data
    data["text"] = note.get("text") or data.get("text", "")
    urls = (note.get("entity_set") or {}).get("urls") or []
    if urls:
        data.setdefault("entities", {})["urls"] = urls
    return data


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


def expand_text_urls(text: str, urls: List[dict], media_urls: List[Optional[str]]) -> str:
    """Rewrite t.co links to their real destinations and drop the media
    placeholder link, matching what X shows on screen (media is rendered
    separately). Done by string replacement — immune to the different index
    conventions (UTF-16 vs code points) between endpoints."""
    for e in urls or []:
        short, full = e.get("url"), e.get("expanded_url")
        if short and full and short in text:
            text = text.replace(short, full)
    for short in media_urls or []:
        if short and short in text:
            text = text.replace(short, " ")
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def normalize_tweet(d: dict) -> dict:
    user = d.get("user") or {}
    tweet_id = d.get("id_str") or str(d.get("id", ""))
    screen = user.get("screen_name", "")
    text = expand_text_urls(
        d.get("text", ""),
        (d.get("entities") or {}).get("urls") or [],
        [m.get("url") for m in (d.get("mediaDetails") or [])],
    )
    return {
        "id": tweet_id,
        "url": f"https://x.com/{screen or 'i'}/status/{tweet_id}",
        "text": text,
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
        # allow_redirects=False: the host allowlist above is the SSRF guard,
        # and following a redirect would bypass it.
        async with session.get(
            media_url, timeout=timeout, headers={"User-Agent": USER_AGENT}, allow_redirects=False
        ) as upstream:
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
                    **cors_for(request),
                    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length",
                },
            )
            length = upstream.headers.get("Content-Length")
            if length:
                resp.content_length = int(length)
            await resp.prepare(request)
            try:
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await resp.write(chunk)
                await resp.write_eof()
            except (ClientError, asyncio.TimeoutError, ConnectionResetError):
                # Headers are already out, so a JSON error body is impossible
                # past this point — the client sees a truncated file and can
                # retry. Close the stream instead of raising on a second
                # response (which aiohttp cannot send after prepare()).
                with suppress(Exception):
                    await resp.write_eof()
            return resp
    except (ClientError, asyncio.TimeoutError):
        return json_error(502, "Media fetch failed — upstream connection error.")


async def health(request: web.Request) -> web.Response:
    return web.Response(text="ok")


# --------------------------------------------------------------------------- #
# App wiring                                                                  #
# --------------------------------------------------------------------------- #

def cors_for(request: web.Request) -> Dict[str, str]:
    """CORS headers for this request: echo the Origin only if it is
    allowlisted, otherwise return nothing (browsers then block the call).
    curl and scripts ignore CORS entirely — abuse from them is the rate
    limiter's job, not CORS's."""
    origin = request.headers.get("Origin", "")
    if origin in ALLOWED_ORIGINS:
        return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
    return {}


@web.middleware
async def cors_middleware(request: web.Request, handler):
    allowed = cors_for(request)
    if request.method == "OPTIONS":
        return web.Response(
            status=204,
            headers={
                **allowed,
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            },
        )
    resp = await handler(request)
    for key, value in allowed.items():
        resp.headers.setdefault(key, value)
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
