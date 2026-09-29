#!/usr/bin/env python3
"""
Integration test for downloader_server.py without touching X's servers.

Starts two mocks on localhost:
  - :8898  fake syndication endpoint serving fixture tweets
  - :8899  fake media CDN serving fake bytes
then starts the real downloader_server with TT_* env overrides and exercises
/api/tweet, /api/thread, /api/download and the error paths.
"""

import asyncio
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from aiohttp import web

# ---- fixtures ---------------------------------------------------------------

def tweet_obj(tid, text, screen, media=None, reply_to=None):
    t = {
        "__typename": "Tweet",
        "id_str": tid,
        "text": text,
        "created_at": "2026-05-22T19:46:16.000Z",
        "user": {
            "name": "Test User",
            "screen_name": screen,
            "profile_image_url_https": "https://pbs.twimg.com/profile_images/abc_normal.jpg",
        },
        "favorite_count": 42,
        "conversation_count": 7,
    }
    if media:
        t["mediaDetails"] = media
    if reply_to:
        t["in_reply_to_status_id_str"] = reply_to
    return t


VIDEO_MEDIA = [
    {
        "type": "video",
        "media_url_https": "https://mock-media.test/video/poster.jpg",
        "sizes": {"large": {"w": 1040, "h": 580}},
        "video_info": {
            "duration_millis": 63500,
            "variants": [
                {"bitrate": 2176000, "content_type": "video/mp4", "url": "http://127.0.0.1:8899/video-2176.mp4"},
                {"bitrate": 832000, "content_type": "video/mp4", "url": "http://127.0.0.1:8899/video-832.mp4"},
                {"content_type": "application/x-mpegURL", "url": "http://127.0.0.1:8899/playlist.m3u8"},
            ]
        },
    }
]

PHOTO_MEDIA = [
    {
        "type": "photo",
        "media_url_https": "https://mock-media.test/photo/abc123.jpg",
        "sizes": {"large": {"w": 1200, "h": 675}},
    }
]

FIXTURES = {
    "111111111111111111": tweet_obj("111111111111111111", "hello world from the mock", "mockuser", media=VIDEO_MEDIA),
    "222222222222222222": tweet_obj("222222222222222222", "photo post", "mockuser", media=PHOTO_MEDIA),
    "333333333333333333": tweet_obj("333333333333333333", "top of a chain", "mockuser", reply_to="222222222222222222"),
    "404444444444444444": None,
    "777777777777777777": tweet_obj(
        "777777777777777777", "video and photos in one post", "mockuser", media=VIDEO_MEDIA + PHOTO_MEDIA
    ),
    # thread continuation below 333: the full chain is 222 <- 333 <- 888
    "888888888888888888": tweet_obj("888888888888888888", "last post of the chain", "mockuser", reply_to="333333333333333333"),
    # a standalone post (its conversation listing has no self-replies)
    "999999999999999999": tweet_obj("999999999999999999", "a standalone post", "mockuser"),
    # root whose conversation endpoint fails -> prefix kept, partial flagged
    "555555555555555555": tweet_obj("555555555555555555", "replies we cannot list", "mockuser"),
    # thread whose conversation listing never ends (bottom cursor loops)
    "1010101010101010101": tweet_obj("1010101010101010101", "listing cut off", "mockuser"),
    "1010101010101010102": tweet_obj("1010101010101010102", "second post", "mockuser", reply_to="1010101010101010101"),
    # X Article (long-form): title + preview + cover only, body needs login
    "1414141414141414141": dict(
        tweet_obj("1414141414141414141", "https://t.co/artlink", "mockuser"),
        article={
            "title": "My 12 favorite GPT tricks",
            "preview_text": "A holiday special covering what I learned.\nSecond line of the preview.",
            "cover_media": {"media_info": {
                "original_img_url": "https://pbs.twimg.com/media/COVER123.jpg",
                "original_img_width": 1280,
                "original_img_height": 512,
            }},
        },
    ),
    # long "note" post: syndication returns a teaser + an empty note_tweet,
    # the full body only exists on the (mocked) guest GraphQL endpoint
    "666666666666666666": dict(
        tweet_obj("666666666666666666", "teaser text https://t.co/media123", "mockuser", media=[dict(PHOTO_MEDIA[0], url="https://t.co/media123")]),
        note_tweet={"note_tweet_results": {"result": {"id": "NoteTweetResults:666"}}},
    ),
}

# sensitive / age-restricted post: the mock syndication endpoint answers this
# ID with HTTP 200 + an empty object (see mock_syndication)
RESTRICTED_ID = "1212121212121212121"

NOTE_FULL_TEXT = "the full body of the note, with a link https://t.co/ghlink"
NOTE_URL_ENTITIES = [
    {"url": "https://t.co/ghlink", "expanded_url": "https://github.com/a/b", "indices": [45, 65]}
]
graphql_hits = []  # counts note-fallback fetches for assertion


async def mock_syndication(request):
    tid = request.query.get("id", "")
    tok = request.query.get("token", "")
    if not tok:  # any token accepted, but one must be sent
        return web.json_response({"detail": "Missing token"}, status=401)
    if tid == RESTRICTED_ID:
        # how X serves sensitive / age-restricted posts to logged-out visitors:
        # HTTP 200 with an empty object
        return web.json_response({})
    data = FIXTURES.get(tid)
    if data is None:
        return web.json_response({"detail": "No status found"}, status=404)
    return web.json_response(data)


async def mock_activate(request):
    graphql_hits.append("activate")
    return web.json_response({"guest_token": "mock-guest-token"})


def _td_tweet(tid, parent, screen="mockuser"):
    """One tweet inside a TweetDetail conversation listing (GraphQL shape)."""
    return {
        "__typename": "Tweet",
        "legacy": {"id_str": tid, "in_reply_to_status_id_str": parent, "full_text": "..."},
        "core": {"user_results": {"result": {"legacy": {"screen_name": screen}}}},
    }


def conv_response(pairs, bottom=None):
    """A TweetDetail page: tweet entries plus an optional bottom cursor."""
    entries = [
        {
            "entryId": f"tweet-{tid}",
            "content": {
                "entryType": "TimelineTimelineItem",
                "itemContent": {"tweet_results": {"result": _td_tweet(tid, parent)}},
            },
        }
        for tid, parent in pairs
    ]
    if bottom:
        entries.append({
            "entryId": f"cursor-bottom-{bottom}",
            "content": {"entryType": "TimelineTimelineCursor", "value": bottom},
        })
    return {"data": {"threaded_conversation_with_injections_v2": {"instructions": [
        {"type": "TimelineAddEntries", "entries": entries}
    ]}}}


async def mock_graphql(request):
    graphql_hits.append("query")
    variables = json.loads(request.query.get("variables", "{}"))
    if "focalTweetId" in variables:  # TweetDetail (conversation listing)
        focal = variables["focalTweetId"]
        if focal == "555555555555555555":
            return web.json_response({"errors": [{"message": "boom"}]}, status=500)
        if focal == "222222222222222222":
            return web.json_response(conv_response([
                ("222222222222222222", None),
                ("333333333333333333", "222222222222222222"),
                ("888888888888888888", "333333333333333333"),
            ]))
        if focal == "999999999999999999":
            return web.json_response(conv_response([("999999999999999999", None)]))
        if focal == "1414141414141414141":  # X Article: a lone post, no self-replies
            return web.json_response(conv_response([("1414141414141414141", None)]))
        if focal == "1010101010101010101":
            return web.json_response(conv_response(
                [("1010101010101010101", None), ("1010101010101010102", "1010101010101010101")],
                bottom="never-ending",
            ))
        return web.json_response({"errors": [{"message": "not found"}]}, status=404)
    if variables.get("tweetId") == "666666666666666666":  # TweetResultByRestId
        return web.json_response({
            "data": {"tweetResult": {"result": {
                "__typename": "Tweet",
                "note_tweet": {"note_tweet_results": {"result": {
                    "id": "NoteTweetResults:666",
                    "text": NOTE_FULL_TEXT,
                    "entity_set": {"urls": NOTE_URL_ENTITIES},
                }}},
            }}}
        })
    return web.json_response({"errors": [{"message": "not found"}]}, status=404)


async def mock_media(request):
    payload = b"FAKEMP4BYTES" * 1000
    return web.Response(body=payload, content_type="video/mp4")


async def _start_mocks():
    app1 = web.Application()
    app1.router.add_get("/tweet-result", mock_syndication)
    app1.router.add_post("/activate", mock_activate)
    app1.router.add_get("/graphql/{tail:.*}", mock_graphql)
    runner1 = web.AppRunner(app1)
    await runner1.setup()
    await web.TCPSite(runner1, "127.0.0.1", 8898).start()

    app2 = web.Application()
    app2.router.add_get("/{tail:.*}", mock_media)
    runner2 = web.AppRunner(app2)
    await runner2.setup()
    await web.TCPSite(runner2, "127.0.0.1", 8899).start()


def _thread_mocks():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(_start_mocks())
    loop.run_forever()


# ---- runner -------------------------------------------------------------------

def run_downloader():
    import os
    import subprocess
    import sys

    env = dict(
        os.environ,
        PORT="8787",
        TT_SYNDICATION_URL="http://127.0.0.1:8898/tweet-result",
        TT_MEDIA_HOSTS="127.0.0.1",
        # point the note-tweet fallback at the local fake guest API
        TT_GUEST_ACTIVATE_URL="http://127.0.0.1:8898/activate",
        TT_GRAPHQL_BASE="http://127.0.0.1:8898/graphql",
        # exercise the conversation down-walk (default-off in production)
        TT_THREAD_DOWNWALK="1",
    )
    proc = subprocess.Popen([sys.executable, "downloader_server.py"], env=env)
    return proc


# macOS system proxies hijack urllib even for localhost — always go direct.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(path, headers=None):
    req = urllib.request.Request("http://127.0.0.1:8787" + path, headers=headers or {})
    try:
        with _opener.open(req, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    # Mocks must run in their own thread+loop: the synchronous check requests
    # below would otherwise block this process's loop and deadlock the mocks.
    thread = threading.Thread(target=_thread_mocks, daemon=True)
    thread.start()
    time.sleep(1.0)
    print("mocks up on :8898 (syndication) and :8899 (media)")

    proc = run_downloader()
    try:
        time.sleep(1.5)
        run_checks()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def run_checks():
    failures = []

    def check(name, cond, detail=""):
        status = "PASS" if cond else "FAIL"
        print(f"[{status}] {name}" + (f"  — {detail}" if detail and not cond else ""))
        if not cond:
            failures.append(name)

    # 1. plain video tweet
    code, headers, body = get("/api/tweet?id=111111111111111111")
    data = json.loads(body)
    check("tweet 200", code == 200, str(body[:200]))
    check("tweet id", data.get("tweet", {}).get("id") == "111111111111111111")
    media = data.get("tweet", {}).get("media", [])
    check("media video", media and media[0]["type"] == "video")
    variants = media[0].get("variants", [])
    check("mp4 variants only", all(v["contentType"] == "video/mp4" for v in variants) and len(variants) == 2, str(variants))
    check("variants sorted desc", variants and variants[0]["bitrate"] >= variants[1]["bitrate"])
    check("duration passed through", media[0].get("durationMs") == 63500, str(media[0].get("durationMs")))

    # 2. photo tweet
    code, _, body = get("/api/tweet?id=222222222222222222")
    data = json.loads(body)
    check("photo tweet 200", code == 200 and data["tweet"]["media"][0]["type"] == "photo")
    check("photo size", data["tweet"]["media"][0]["width"] == 1200)

    # 3. thread chain (222 -> parent chain: 333 claims parent 222)
    code, _, body = get("/api/thread?url=https://x.com/mockuser/status/333333333333333333")
    data = json.loads(body)
    check("thread 200", code == 200, str(body[:200]))
    check("thread ordered asc", [t["id"] for t in data["tweets"]] == sorted([t["id"] for t in data["tweets"]], key=int))

    # 4. 404 tweet -> friendly error
    code, _, body = get("/api/tweet?id=404444444444444444")
    check("404 mapped", code == 404 and "not found" in body.decode().lower(), f"{code} {body[:120]}")

    # 4b. restricted post (200 + empty object upstream) -> explained 403
    code, _, body = get(f"/api/tweet?id={RESTRICTED_ID}")
    data = json.loads(body)
    check(
        "restricted -> explained 403",
        code == 403 and "logged-in users" in data.get("error", ""),
        f"{code} {body[:140]}",
    )
    code, _, body = get(f"/api/thread?url=https://x.com/mockuser/status/{RESTRICTED_ID}")
    data = json.loads(body)
    check(
        "restricted thread -> explained 403",
        code == 403 and "logged-in users" in data.get("error", ""),
        f"{code} {body[:140]}",
    )

    # 5. download proxy (allowlist overridden to include 127.0.0.1)
    code, headers, body = get("/api/download?url=http://127.0.0.1:8899/video-832.mp4&name=test-video.mp4")
    check("download 200", code == 200, str(code))
    check("download attachment", "attachment" in headers.get("Content-Disposition", ""), str(headers.get("Content-Disposition")))
    check("download bytes", b"FAKEMP4BYTES" in body)

    # 6. download host allowlist
    code, _, body = get("/api/download?url=http://evil.example.com/x.mp4&name=x.mp4")
    check("download allowlist blocks", code == 400, str(code))

    # 7. bad input
    code, _, body = get("/api/tweet?id=notanid")
    check("bad input 400", code == 400)

    # 8. cached second fetch
    code, _, body = get("/api/tweet?id=111111111111111111")
    check("cache hit", code == 200 and json.loads(body).get("cached") is True)

    # 9. t.co expansion (pure function, no network)
    import downloader_server as ds
    txt = ds.expand_text_urls(
        "look https://t.co/abc and https://t.co/xyz",
        [{"url": "https://t.co/abc", "expanded_url": "https://github.com/a/b"}],
        ["https://t.co/xyz"],
    )
    check("t.co expansion", txt == "look https://github.com/a/b and", repr(txt))
    check("expansion no-op safe", ds.expand_text_urls("plain text", [], []) == "plain text")

    # 10. rate limiting keys on the real client IP (60 req / 60 s)
    rl_ip = "203.0.113.77"
    for _ in range(61):
        code, _, _ = get("/api/tweet?id=111111111111111111", headers={"CF-Connecting-IP": rl_ip})
    check("rate limit 429 on 61st", code == 429, str(code))
    code, _, _ = get("/api/tweet?id=111111111111111111", headers={"X-Forwarded-For": "198.51.100.9"})
    check("separate bucket per ip", code == 200, str(code))
    code, _, _ = get(
        "/api/tweet?id=111111111111111111",
        headers={"CF-Connecting-IP": rl_ip, "X-Forwarded-For": "198.51.100.9"},
    )
    check("CF-Connecting-IP beats XFF", code == 429, str(code))

    # 11. long-note fallback through the (mocked) guest GraphQL endpoint
    code, _, body = get("/api/tweet?id=666666666666666666")
    d = json.loads(body)
    t = d.get("tweet", {}).get("text", "")
    check("note fallback 200", code == 200, str(body[:150]))
    check("note full text", "full body of the note" in t, repr(t[:120]))
    check("note link expanded", "https://github.com/a/b" in t and "t.co" not in t, repr(t))
    check("note media link dropped", "media123" not in t, repr(t))
    check("guest api called once", graphql_hits.count("activate") == 1 and graphql_hits.count("query") >= 1, str(graphql_hits))
    # second fetch is cached — no new upstream note fetch
    before = len(graphql_hits)
    get("/api/tweet?id=666666666666666666")
    check("note fetch cached", len(graphql_hits) == before)

    # 12. CORS: allowlisted origins get their Origin echoed, everyone else nothing
    code, headers, _ = get("/api/tweet?id=111111111111111111", headers={"Origin": "https://twittertools.com"})
    check("cors site origin echoed", headers.get("Access-Control-Allow-Origin") == "https://twittertools.com", str(headers.get("Access-Control-Allow-Origin")))
    code, headers, _ = get("/api/tweet?id=111111111111111111", headers={"Origin": "http://localhost:4321"})
    check("cors dev origin allowed", headers.get("Access-Control-Allow-Origin") == "http://localhost:4321", str(headers.get("Access-Control-Allow-Origin")))
    code, headers, _ = get("/api/tweet?id=111111111111111111", headers={"Origin": "https://evil.example.com"})
    check("cors foreign origin gets nothing", "Access-Control-Allow-Origin" not in headers, str(headers.get("Access-Control-Allow-Origin")))
    preflight = urllib.request.Request(
        "http://127.0.0.1:8787/api/tweet",
        method="OPTIONS",
        headers={"Origin": "https://twittertools.com", "Access-Control-Request-Method": "GET"},
    )
    with _opener.open(preflight, timeout=15) as r:
        check("cors preflight echoed", r.status == 204 and r.headers.get("Access-Control-Allow-Origin") == "https://twittertools.com", str(r.status))
    code, headers, _ = get("/api/download?url=http://127.0.0.1:8899/video-832.mp4&name=v.mp4", headers={"Origin": "https://twittertools.com"})
    check("download cors echoed", headers.get("Access-Control-Allow-Origin") == "https://twittertools.com", str(headers.get("Access-Control-Allow-Origin")))

    # 13. mixed media (video + photos) survives in order
    code, _, body = get("/api/tweet?id=777777777777777777")
    data = json.loads(body)
    kinds = [m["type"] for m in data.get("tweet", {}).get("media", [])]
    check("mixed media kept", code == 200 and kinds == ["video", "photo"], str(kinds))

    # 14. thread from the FIRST post: nothing above it, the conversation
    # endpoint supplies the self-replies below the root
    code, _, body = get("/api/thread?url=https://x.com/mockuser/status/222222222222222222")
    data = json.loads(body)
    ids = [t["id"] for t in data.get("tweets", [])]
    full = ["222222222222222222", "333333333333333333", "888888888888888888"]
    check("first-post paste = full thread", code == 200 and ids == full and not data.get("partial"), f"{ids} partial={data.get('partial')}")

    # 15. thread from a MIDDLE post: up-walk + down-walk dedupe to the same set
    code, _, body = get("/api/thread?url=https://x.com/mockuser/status/888888888888888888")
    data = json.loads(body)
    ids = [t["id"] for t in data.get("tweets", [])]
    check("middle-post paste = full thread", code == 200 and ids == full, str(ids))

    # 16. standalone post: conversation has no self-replies -> complete, no warning
    code, _, body = get("/api/thread?url=999999999999999999")
    data = json.loads(body)
    check(
        "lone post complete",
        code == 200 and len(data.get("tweets", [])) == 1 and not data.get("partial"),
        str(body[:150]),
    )

    # 17. conversation listing cut off by the page cap -> honest partial flag
    code, _, body = get("/api/thread?url=1010101010101010101")
    data = json.loads(body)
    ids = [t["id"] for t in data.get("tweets", [])]
    check(
        "truncated conversation flagged",
        code == 200 and data.get("partial") and data.get("reason") == "conversation_truncated"
        and ids == ["1010101010101010101", "1010101010101010102"],
        str(body[:200]),
    )

    # 18. X Article: title+preview become the text, cover becomes a photo,
    # article flag set, no bare t.co link left in the text. Runs before the
    # endpoint-down test so the guest breaker is still cold for the down-walk.
    code, _, body = get("/api/tweet?id=1414141414141414141")
    data = json.loads(body).get("tweet", {})
    check("article 200", code == 200, str(body[:150]))
    check(
        "article text = title + preview",
        data.get("text") == "My 12 favorite GPT tricks\n\nA holiday special covering what I learned.\nSecond line of the preview.",
        repr(data.get("text")),
    )
    check("article t.co dropped", "t.co" not in data.get("text", ""))
    media = data.get("media", [])
    check(
        "article cover as photo",
        media and media[0]["type"] == "photo" and media[0]["url"] == "https://pbs.twimg.com/media/COVER123.jpg"
        and media[0]["width"] == 1280 and media[0]["height"] == 512,
        str(media),
    )
    check("article flag", data.get("article") is True)
    code, _, body = get("/api/thread?url=1414141414141414141")
    data = json.loads(body)
    check(
        "article in thread reader",
        code == 200 and len(data.get("tweets", [])) == 1 and data["tweets"][0].get("article") is True
        and not data.get("partial"),
        str(body[:150]),
    )

    # 19. conversation endpoint down -> prefix kept, partial flagged because the
    # root has replies. Must run last: the 500 trips the guest-API breaker.
    code, _, body = get("/api/thread?url=555555555555555555")
    data = json.loads(body)
    check(
        "endpoint down -> partial prefix",
        code == 200 and data.get("partial") and data.get("reason") == "replies_unavailable",
        str(body[:200]),
    )

    # 20. healthz: aggregate counters reflect the traffic from this run
    code, _, body = get("/api/healthz")
    data = json.loads(body)
    check("healthz 200", code == 200, str(code))
    tweet_counts = data.get("responses", {}).get("/api/tweet", {})
    check("healthz counts responses", tweet_counts.get("200", 0) >= 1, str(tweet_counts))
    upstream = data.get("upstream_syndication", {})
    check(
        "healthz upstream stats",
        upstream.get("calls", 0) >= 1 and "200" in upstream.get("statuses", {}) and upstream.get("avg_ms") is not None,
        str(upstream),
    )
    check(
        "healthz cache counters",
        isinstance(data.get("tweet_cache", {}).get("size"), int) and data["tweet_cache"]["hits"] >= 0,
        str(data.get("tweet_cache")),
    )

    print()
    if failures:
        print("FAILED:", failures)
        raise SystemExit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
