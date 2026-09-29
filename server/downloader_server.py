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
                                  Walks the syndication parent chain upward; a paste
                                  of the thread's LAST post returns the whole thread.
                                  TT_THREAD_DOWNWALK=1 additionally fetches the
                                  author's self-replies below the root (guest
                                  conversation endpoint — currently closed by X).
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
# Conversation variant of the guest API: returns the focal tweet's reply tree,
# the only way to walk a thread downward (syndication exposes just the parent
# pointer). VERIFIED DEAD for guests on 2026-09-28 (404 on every known id, and
# UserTweetsAndReplies/v1.1 search are closed too) — so the down-walk below is
# env-gated off. If X ever re-opens guest conversation access, set
# TT_THREAD_DOWNWALK=1 (+ override TT_TWEET_DETAIL_QUERY_ID if rotated) and the
# thread reader unrolls full threads from ANY post again.
TWEET_DETAIL_QUERY_ID = os.environ.get("TT_TWEET_DETAIL_QUERY_ID", "xOhkmRac04YFZmOzU9PJHg")
THREAD_DOWNWALK_ENABLED = os.environ.get("TT_THREAD_DOWNWALK", "0") == "1"
THREAD_MAX_DETAIL_PAGES = 3  # each conversation page carries ~20 entries
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

    def __len__(self) -> int:
        return len(self._data)


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


class Stats:
    """Aggregate counters for /api/healthz. In-memory and anonymous: how the
    free upstream is holding up (status distribution, latency) and how well
    the cache absorbs repeat traffic. No IPs, no IDs, no content."""

    def __init__(self) -> None:
        self.started = time.time()
        self.responses: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.upstream: Dict[str, int] = defaultdict(int)
        self.upstream_ms_total = 0.0
        self.upstream_calls = 0
        self.cache_hits = 0

    def note_response(self, endpoint: str, status: int) -> None:
        self.responses[endpoint][str(status)] += 1

    def note_upstream(self, status: int, ms: float) -> None:
        self.upstream[str(status)] += 1
        self.upstream_ms_total += ms
        self.upstream_calls += 1

    def snapshot(self) -> dict:
        return {
            "uptime_s": int(time.time() - self.started),
            "responses": {ep: dict(c) for ep, c in sorted(self.responses.items())},
            "upstream_syndication": {
                "statuses": dict(self.upstream),
                "calls": self.upstream_calls,
                "avg_ms": round(self.upstream_ms_total / self.upstream_calls, 1)
                if self.upstream_calls
                else None,
            },
            "tweet_cache": {"hits": self.cache_hits, "size": len(tweet_cache)},
        }


STATS = Stats()

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


def syndication_error_response(status: int) -> web.Response:
    """Translate an upstream fetch status into an API error the frontend
    shows verbatim.

    NOTE: never answer HTTP 502 here. The production stack (Apache/Cloudflare)
    replaces origin 502 bodies with its own terse error page, which would
    strip the JSON message below — 503 passes through untouched."""
    if status == 404:
        return json_error(404, "Post not found — it may be deleted, protected, or the link is wrong.")
    if status == 403:
        # syndication answered 200 with an empty object: the post exists but
        # X withholds its content from logged-out visitors
        return json_error(
            403,
            "X only shows this post to logged-in users — most often because it "
            "contains sensitive or age-restricted media. A no-sign-up tool can't fetch it.",
        )
    if status == 401:
        return json_error(403, "This post is not available for embedding (likely protected).")
    if status == 429:
        return json_error(429, "X is rate-limiting us right now — please retry in a minute.")
    return json_error(503, "X's embed endpoint didn't respond properly — please try again in a moment.")


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
            # 200 + empty object = the post exists but X withholds its content
            # from logged-out visitors (sensitive / age-restricted media);
            # keep it distinct from a transport failure
            if isinstance(data, dict) and not data:
                return 200, {}
            return resp.status, None
    except (ClientError, asyncio.TimeoutError):
        return 599, None


async def fetch_syndication(session: ClientSession, tweet_id: str) -> Tuple[int, Optional[dict]]:
    """Timed wrapper — feeds /api/healthz with the final upstream status."""
    t0 = time.monotonic()
    status, data = await _fetch_syndication(session, tweet_id)
    STATS.note_upstream(status, (time.monotonic() - t0) * 1000)
    return status, data


async def _fetch_syndication(session: ClientSession, tweet_id: str) -> Tuple[int, Optional[dict]]:
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
        if data:  # non-empty tweet payload
            async with _token_mode_lock:
                _working_token = token
            data = await enrich_note_tweet(session, tweet_id, data)
            return 200, data
        if status == 200 and data == {}:
            # login-walled content: definitive, same answer for every token
            return 403, None
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
    return (last_status or 599), None


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
# Thread completion via the conversation endpoint                             #
# --------------------------------------------------------------------------- #
# The syndication endpoint only exposes each tweet's PARENT, so walking it
# upward from the pasted post collects just the ancestors — a paste of the
# first or a middle post would silently return a prefix. X's web client gets
# the rest from TweetDetail, whose conversation listing enumerates the focal
# tweet's replies; we use it purely as a map (id, parent, author) of the
# self-reply chain and still fetch all content from syndication, so media and
# note-tweet handling stay single-sourced there.

async def _query_tweet_detail(
    session: ClientSession, tweet_id: str, token: str, cursor: Optional[str] = None
) -> Tuple[int, Optional[List[dict]], Optional[str]]:
    """One page of the conversation listing as [{id, parent, handle}] plus the
    bottom cursor for pagination, or (status, None, None) on failure."""
    variables: Dict[str, Any] = {
        "focalTweetId": tweet_id,
        "with_rux_injections": False,
        "rankingMode": "Relevance",
        "includePromotedContent": False,
        "withCommunity": False,
        "withQuickPromoteEligibilityTweetFields": True,
        "withBirdwatchNotes": False,
        "withVoice": True,
    }
    if cursor:
        variables["cursor"] = cursor
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
            f"{GRAPHQL_BASE}/{TWEET_DETAIL_QUERY_ID}/TweetDetail",
            params=params, headers=headers, timeout=GRAPHQL_TIMEOUT,
        ) as resp:
            if resp.status != 200:
                return resp.status, None, None
            data = await resp.json(content_type=None)
    except (ClientError, asyncio.TimeoutError):
        return 599, None, None

    conv = (data.get("data") or {}).get("threaded_conversation_with_injections_v2") or {}
    tweets: List[dict] = []
    bottom: Optional[str] = None
    for ins in conv.get("instructions") or []:
        if ins.get("type") != "TimelineAddEntries":
            continue
        for entry in ins.get("entries") or []:
            content = entry.get("content") or {}
            entry_id = entry.get("entryId") or ""
            if entry_id.startswith("cursor-bottom"):
                bottom = content.get("value") or bottom
                continue
            # replies are grouped into conversationthread modules; recurse in
            if content.get("entryType") == "TimelineTimelineModule":
                items = [(it.get("item") or {}).get("content") or {} for it in content.get("items") or []]
            elif content.get("entryType") == "TimelineTimelineItem":
                items = [content]
            else:
                items = []
            for c in items:
                tr = ((c.get("itemContent") or {}).get("tweet_results") or {}).get("result") or {}
                if tr.get("__typename") == "TweetWithVisibilityResults":
                    tr = tr.get("tweet") or {}
                legacy = tr.get("legacy")
                if not legacy:  # tombstones, promoted content
                    continue
                user = (((tr.get("core") or {}).get("user_results") or {}).get("result") or {}).get("legacy") or {}
                tweets.append({
                    "id": legacy.get("id_str"),
                    "parent": legacy.get("in_reply_to_status_id_str"),
                    "handle": user.get("screen_name", ""),
                })
    return 200, tweets, bottom


def _follow_self_reply_chain(candidates: List[dict], root_id: str, root_handle: str) -> List[str]:
    """Chain of the author's own replies, each answering the previous post.
    Strict parent-pointer matching keeps out the author's replies to other
    people's comments (they parent to the comment, not to the thread). A
    deleted middle post breaks the walk — pasting the last post still works
    for those threads via the upward walk."""
    chain: List[str] = []
    seen = {root_id}
    current = root_id
    while True:
        nxt = next(
            (
                c for c in candidates
                if c["parent"] == current and c["handle"] == root_handle and c["id"] not in seen
            ),
            None,
        )
        if not nxt:
            return chain
        chain.append(nxt["id"])
        seen.add(nxt["id"])
        current = nxt["id"]


async def collect_descendants(
    session: ClientSession, root_id: str, root_handle: str
) -> Tuple[Optional[List[str]], bool]:
    """Self-reply ids below the thread root, in order, or (None, False) when
    the endpoint is unavailable (circuit breaker, rate limit, shape change).
    (ids, True) means pagination hit the page cap with a cursor left — the
    listing was cut off and there may be more posts we could not see."""
    global _guest_cooldown_until
    if not GUEST_API_ENABLED or time.time() < _guest_cooldown_until:
        return None, False
    token = await get_guest_token(session)
    if not token:
        _guest_cooldown_until = time.time() + GRAPHQL_COOLDOWN
        return None, False

    candidates: List[dict] = []
    cursor: Optional[str] = None
    truncated = False
    for _ in range(THREAD_MAX_DETAIL_PAGES):
        status, page, bottom = await _query_tweet_detail(session, root_id, token, cursor)
        if status in (401, 403, 429) and token:  # stale or rate-limited guest token
            token = await get_guest_token(session, force=True)
            if token:
                status, page, bottom = await _query_tweet_detail(session, root_id, token, cursor)
        if status != 200 or page is None:
            _guest_cooldown_until = time.time() + GRAPHQL_COOLDOWN
            return None, False
        candidates.extend(page)
        chain = _follow_self_reply_chain(candidates, root_id, root_handle)
        if not bottom:
            return chain, False
        cursor = bottom
    # Page cap reached with a cursor still outstanding: the conversation
    # listing itself ran out before the thread did.
    truncated = True
    return chain, truncated


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
    duration_ms = None
    variants = []
    if mtype in ("video", "animated_gif"):
        info = m.get("video_info") or {}
        duration_ms = info.get("duration_millis")
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
        # duration lets the frontend derive each variant's file size
        # (bitrate × duration) without probing the CDN
        "durationMs": duration_ms,
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
    media_details = list(d.get("mediaDetails") or [])
    # X Article (long-form post): both free endpoints carry only the title,
    # a two-line preview and the cover image — the body needs a logged-in
    # client. Surface what exists instead of leaving a bare t.co link, and
    # flag it so UIs can explain why there is no full text.
    article = d.get("article") or {}
    if article:
        title = (article.get("title") or "").strip()
        preview = (article.get("preview_text") or "").strip()
        text = "\n\n".join(part for part in (title, preview) if part)
        cover = ((article.get("cover_media") or {}).get("media_info") or {})
        if cover.get("original_img_url") and not any(
            m.get("media_url_https") == cover["original_img_url"] for m in media_details
        ):
            media_details.append({
                "type": "photo",
                "media_url_https": cover["original_img_url"],
                "sizes": {
                    "large": {"w": cover.get("original_img_width"), "h": cover.get("original_img_height")}
                },
            })
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
        "media": [normalize_media(m) for m in media_details],
        "likes": d.get("favorite_count"),
        "replies": d.get("conversation_count"),
        "replyToId": d.get("in_reply_to_status_id_str"),
        "article": bool(article),
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
        STATS.cache_hits += 1
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
            status, data = 599, None

        tweet = None
        if data is not None:
            try:
                tweet = normalize_tweet(data)
                tweet_cache.put(tweet_id, tweet)
            except Exception:
                status, tweet = 599, None
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

    return syndication_error_response(status)


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
        # the root post itself failed: report the real cause, not a blanket 404
        return syndication_error_response(status)

    tweets.sort(key=lambda t: int(t["id"] or 0))
    root = tweets[0]

    # Downward completion (TT_THREAD_DOWNWALK=1): the up-walk only ever
    # returns the pasted post's ancestors, so a paste of the first/middle
    # post needs the self-reply chain fetched from the root via the
    # conversation endpoint. Dead for guests since 2026-09 — the default-off
    # gate keeps production requests free of its cost. When enabled, endpoint
    # failure degrades to the prefix; if the root has any replies at all that
    # fallback is flagged partial rather than passed off as whole.
    if THREAD_DOWNWALK_ENABLED and root.get("user", {}).get("screenName"):
        ids, truncated = await collect_descendants(session, root["id"], root["user"]["screenName"])
        if truncated:
            partial = True
            reason = "conversation_truncated"
        if ids is None and int(root.get("replies") or 0) > 0:
            partial = True
            reason = "replies_unavailable"
        if ids:
            for tid in ids:
                if tid in seen:
                    continue
                seen.add(tid)
                status, data = await fetch_syndication(session, tid)
                if data is None:
                    partial = True
                    reason = f"chain_interrupted_{status}"
                    break
                tweets.append(normalize_tweet(data))
                await asyncio.sleep(0.15)  # be polite to the free endpoint
            tweets.sort(key=lambda t: int(t["id"] or 0))

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
                return json_error(503, f"Media fetch failed ({upstream.status}).")
            content_type = upstream.headers.get("Content-Type", "application/octet-stream")
            filename = _safe_filename(want_name, media_url, content_type)
            resp = web.StreamResponse(
                status=200,
                headers={
                    "Content-Type": content_type,
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    # twimg media URLs are immutable, so proxied media may sit
                    # in the browser cache for a week — repeat views (e.g. the
                    # bookmark library re-rendering) stop hitting the origin.
                    "Cache-Control": "public, max-age=604800",
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
        return json_error(503, "Media fetch failed — upstream connection error.")


async def health(request: web.Request) -> web.Response:
    return web.Response(text="ok")


async def api_healthz(request: web.Request) -> web.Response:
    """Aggregate, anonymous counters — how the free upstream is holding up."""
    return web.json_response(STATS.snapshot())


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
async def stats_middleware(request: web.Request, handler):
    """Count API response statuses for /api/healthz (CORS preflight excluded)."""
    resp = await handler(request)
    if request.path.startswith("/api/") and request.method != "OPTIONS":
        STATS.note_response(request.path, resp.status)
    return resp


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
    app = web.Application(middlewares=[stats_middleware, cors_middleware])
    app.on_startup.append(on_startup)
    app.router.add_get("/api/tweet", api_tweet)
    app.router.add_get("/api/thread", api_thread)
    app.router.add_get("/api/download", api_download)
    app.router.add_get("/api/healthz", api_healthz)
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
