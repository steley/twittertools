#!/usr/bin/env python3
"""
Long-running mock servers for frontend development without X access:
  :8898 fake syndication endpoint   :8899 fake media CDN
Run `downloader_server.py` with TT_SYNDICATION_URL / TT_MEDIA_HOSTS pointing
at them (see README "Local development without X access").
"""

import asyncio
import os

from aiohttp import web

from mock_test import VIDEO_MEDIA, PHOTO_MEDIA, tweet_obj

SYND_PORT = int(os.environ.get("SYND_PORT", "8898"))
MEDIA_PORT = int(os.environ.get("MEDIA_PORT", "8899"))


async def mock_syndication(request):
    fixtures = {
        "111111111111111111": tweet_obj("111111111111111111", "Hello world from the mock endpoint! This post has a video attached.", "mockuser", media=VIDEO_MEDIA),
        "222222222222222222": tweet_obj("222222222222222222", "Photo mode: two nice pictures from the mock.", "mockuser", media=PHOTO_MEDIA * 2),
        "333333333333333333": tweet_obj("333333333333333333", "1/ This is the first post of a mock thread.", "mockuser", reply_to="222222222222222222"),
        "444444444444444444": tweet_obj("444444444444444444", "Mixed mode: a video and a photo in one post.", "mockuser", media=VIDEO_MEDIA + PHOTO_MEDIA),
        # restricted (sensitive / age-restricted): X answers 200 + empty object
        "1212121212121212121": {},
        # reply from a DIFFERENT author that opens with @mockuser — exercises
        # the screenshot thread card's "Replying to" treatment
        "1313131313131313131": tweet_obj(
            "1313131313131313131", "@mockuser Couldn't agree more — she earned it.", "otheruser"
        ),
        # reply-to-a-reply: mentions the PREVIOUS reply's author (otheruser),
        # not the main post's — exercises the chain-parent mention strip
        "1515151515151515151": tweet_obj(
            "1515151515151515151", "@otheruser the podium shots are stunning.", "thirduser"
        ),
        # post with an embedded quoted tweet (thread reader inline card)
        "1717171717171717171": dict(
            tweet_obj("1717171717171717171", "Worth quoting in full.", "mockuser"),
            quoted_tweet=tweet_obj("1616161616161616161", "Original take worth quoting.", "otheruser"),
        ),
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
    await web.TCPSite(runner1, "127.0.0.1", SYND_PORT).start()

    app2 = web.Application()
    app2.router.add_get("/{tail:.*}", mock_media)
    runner2 = web.AppRunner(app2)
    await runner2.setup()
    await web.TCPSite(runner2, "127.0.0.1", MEDIA_PORT).start()

    print(f"dev mocks: syndication :{SYND_PORT}, media :{MEDIA_PORT}")
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
