#!/usr/bin/env python3
"""
Long-running mock servers for frontend development without X access:
  :8898 fake syndication endpoint   :8899 fake media CDN
Run `downloader_server.py` with TT_SYNDICATION_URL / TT_MEDIA_HOSTS pointing
at them (see README "Local development without X access").
"""

import asyncio
from aiohttp import web

from mock_test import VIDEO_MEDIA, PHOTO_MEDIA, tweet_obj


async def mock_syndication(request):
    fixtures = {
        "111111111111111111": tweet_obj("111111111111111111", "Hello world from the mock endpoint! This post has a video attached.", "mockuser", media=VIDEO_MEDIA),
        "222222222222222222": tweet_obj("222222222222222222", "Photo mode: two nice pictures from the mock.", "mockuser", media=PHOTO_MEDIA * 2),
        "333333333333333333": tweet_obj("333333333333333333", "1/ This is the first post of a mock thread.", "mockuser", reply_to="222222222222222222"),
    }
    data = fixtures.get(request.query.get("id", ""))
    if data is None:
        return web.json_response({"detail": "No status found"}, status=404)
    return web.json_response(data)


async def mock_media(request):
    return web.Response(body=b"FAKEMP4BYTES" * 1000, content_type="video/mp4")


async def main():
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

    print("dev mocks: syndication :8898, media :8899")
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
