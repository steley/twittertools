"""Serve dist/ on :8080 and forward /api/* + /health to the backend on :8787.

Makes the built site's same-origin API_BASE work locally and in CI, the way
Apache reverse-proxies it in production:

    server: python dev_proxy.py          (defaults: :8080 -> dist/, API :8787)

Environment: DIST_PORT, API_PORT, DIST_DIR override the defaults.
"""
import asyncio
import os
import pathlib

from aiohttp import ClientSession, web

DIST = pathlib.Path(os.environ.get("DIST_DIR", pathlib.Path(__file__).resolve().parent.parent / "dist"))
API_PORT = int(os.environ.get("API_PORT", "8787"))
DIST_PORT = int(os.environ.get("DIST_PORT", "8080"))

# request headers forwarded to the API (Range matters: <video> seeking needs
# it to survive the hop, exactly as the production reverse proxy does)
DROP_HEADERS = {"host", "accept-encoding", "connection", "content-length", "transfer-encoding"}


async def proxy(request: web.Request) -> web.Response:
    url = f"http://127.0.0.1:{API_PORT}" + request.rel_url.path_qs
    headers = {k: v for k, v in request.headers.items() if k.lower() not in DROP_HEADERS}
    async with request.app["session"].get(url, headers=headers) as upstream:
        body = await upstream.read()
        headers = {k: v for k, v in upstream.headers.items()
                   if k.lower() not in ("content-length", "content-type", "transfer-encoding")}
        return web.Response(status=upstream.status, body=body, headers=headers,
                            content_type=upstream.headers.get("Content-Type", "text/plain").split(";")[0].strip())


async def handler(request: web.Request) -> web.StreamResponse:
    path = request.rel_url.path
    if path.startswith("/api/") or path == "/health":
        return await proxy(request)
    rel = path.lstrip("/")
    candidates = []
    if rel:
        candidates.append(DIST / rel)
        if not rel.endswith("/"):
            candidates.append(DIST / (rel + "/index.html"))
        else:
            candidates.append(DIST / rel / "index.html")
    candidates.append(DIST / "index.html")
    for f in candidates:
        if f.is_file():
            return web.FileResponse(f)
    return web.Response(status=404, text="not found: " + path)


def make_app() -> web.Application:
    app = web.Application()
    app["session"] = ClientSession()
    app.router.add_route("GET", "/{tail:.*}", handler)
    return app


async def main() -> None:
    app = make_app()
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", DIST_PORT).start()
    print(f"dist+proxy on :{DIST_PORT} -> dist/ {DIST}", flush=True)
    while True:
        await asyncio.sleep(60)


if __name__ == "__main__":
    asyncio.run(main())
