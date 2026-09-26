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
}


async def mock_syndication(request):
    tid = request.query.get("id", "")
    tok = request.query.get("token", "")
    if not tok:  # any token accepted, but one must be sent
        return web.json_response({"detail": "Missing token"}, status=401)
    data = FIXTURES.get(tid)
    if data is None:
        return web.json_response({"detail": "No status found"}, status=404)
    return web.json_response(data)


async def mock_media(request):
    payload = b"FAKEMP4BYTES" * 1000
    return web.Response(body=payload, content_type="video/mp4")


async def _start_mocks():
    app1 = web.Application()
    app1.router.add_get("/tweet-result", mock_syndication)
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
    )
    proc = subprocess.Popen([sys.executable, "downloader_server.py"], env=env)
    return proc


# macOS system proxies hijack urllib even for localhost — always go direct.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(path):
    try:
        with _opener.open("http://127.0.0.1:8787" + path, timeout=15) as r:
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

    print()
    if failures:
        print("FAILED:", failures)
        raise SystemExit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
