# TwitterTools.com

**The independent toolkit for X (Twitter).** Static Astro site + one tiny Python API.

V1 ships eight free, no-login tools:

| Path | Tool | Backend? |
| --- | --- | --- |
| `/twitter-video-downloader` | Video/GIF → MP4 in available qualities (direct CDN download, proxy fallback) | yes (`/api/tweet`, `/api/download`) |
| `/twitter-image-downloader` | Photos in original resolution, one or all | yes (`/api/tweet`, `/api/download`) |
| `/twitter-thread-reader` | Unroll threads, photos in exports, export Markdown/TXT/HTML/PDF, paste-mode fallback | yes (`/api/thread`, best-effort) |
| `/bookmark-manager` | Private local bookmark library (IndexedDB), tags/notes, JSON & Markdown export | no |
| `/tweet-screenshot-generator` | Post → polished PNG card, light/dark, rendered on canvas | no |
| `/tweet-character-counter` | X weighted counting (CJK ×2, links = 23) | no |
| `/tweet-url-parser` | URL ↔ ID ↔ Snowflake timestamp | no |
| `/twitter-advanced-search-builder` | GUI → search operators → open on X | no |

```
├── src/pages/          8 tool pages + home + privacy + terms (Astro + Tailwind v4)
├── src/lib/            shared modules: api client (incl. guest GraphQL fallback), tweet card
│                       renderer, bookmark store, tweet-count, snowflake, tool registry
├── server/             downloader_server.py (aiohttp) + systemd unit + mock/dev tooling
├── deploy/             Apache vhost (current VPS) + nginx config (alternative)
├── scripts/gen_og.py   regenerates public/og.png (social card)
└── public/             robots.txt, favicon.svg, og.png
```

## How the data tools work (no paid X API)

`downloader_server.py` resolves public posts through X's **free syndication endpoint**
(`cdn.syndication.twimg.com/tweet-result`) — the same one that powers embeds on publisher
sites. No developer account, no OAuth, no per-read billing. It:

- computes the endpoint's token locally (react-tweet's algorithm; several candidates are
  tried and the working one is remembered),
- normalizes tweets to `{id, text, user, media[], replyToId, quoted}` with **MP4-only**
  video variants sorted by bitrate,
- proxies media downloads straight from `pbs.twimg.com` / `video.twimg.com` with
  `Content-Disposition: attachment` — **nothing is stored on disk**,
- caches responses for 10 min, dedupes concurrent lookups, rate-limits per IP
  (60 lookups/min, 40 downloads/min).

Honest limitations (also stated in the UI):

- The syndication endpoint is undocumented and has no SLA. If X changes it, only
  `fetch_syndication()` / `candidate_tokens()` in `downloader_server.py` need updating.
- The endpoint does **not** expose reply chains, so thread unrolling is best-effort: a
  thread root returns that single post and the UI directs users to the paste mode, whose
  exports work identically.
- Protected/deleted posts can't be fetched (mapped to friendly 404/403 errors).

## Local development

CI (`.github/workflows/ci.yml`) runs the same checks on every push:
`astro check` + production build for the frontend, pyflakes + the offline
integration suite for the backend.

```bash
npm install
npm run dev                 # site at http://localhost:4321

# API for the downloader/thread tools (Python 3.9+):
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python downloader_server.py          # 127.0.0.1:8787

# If your machine can't reach X directly (e.g. censored network), route the
# backend through a local proxy — socks5h resolves DNS on the proxy side:
TT_PROXY=socks5h://127.0.0.1:1089 .venv/bin/python downloader_server.py
```

`astro dev` automatically points the browser at the locally running API
(`127.0.0.1:8787`) — no environment files needed. Production builds always call
same-origin `/api/` (nginx reverse proxy), so there is nothing to switch and no
dev configuration to leak into `dist/`.

### Local development without X access

`server/mock_test.py` runs 16 integration checks against local mocks — the full backend
can be developed and verified offline:

```bash
cd server && .venv/bin/python mock_test.py     # ALL CHECKS PASSED
.venv/bin/python dev_mocks.py                  # long-running mocks for the frontend
```

With `dev_mocks.py` + the API running (both with `TT_*` env overrides, as `mock_test.py`
does automatically), mock tweet `111111111111111111` returns video variants,
`222222222222222222` photos, `333333333333333333` a reply-chain sample.

## Production build

```bash
npm run build               # -> dist/  (9 pages, sitemap-index.xml included)
```

Verify `dist/` contains no dev references: `grep -r "127.0.0.1" dist/` should be empty.

## Deploy to the VPS

Two server configs are provided — **Apache** (`deploy/apache-twittertools.conf`,
what this VPS currently runs, with the certbot-managed certificate) and
**nginx** (`deploy/nginx-twittertools.conf`, alternative). Steps 1–2 are
identical; pick **3A or 3B**. Step 4 differs only in who renews the cert.

### 1. Upload (from the local machine)

```bash
# One rsync per directory: each --delete is scoped to its own destination
# and cannot touch the others (a combined `rsync --delete server/ deploy/
# .../twittertools/` MERGES both into the top level and deletes dist/ —
# do not do that).  .venv MUST be excluded on server/: it doesn't exist
# locally (and would carry macOS binaries), and without --exclude the
# --delete pass would wipe the Linux venv from step 2 on every re-deploy.
rsync -av --delete dist/   root@VPS_IP:/var/www/twittertools/dist/
rsync -av --delete --exclude .venv --exclude __pycache__ \
     server/ root@VPS_IP:/var/www/twittertools/server/
rsync -av --delete deploy/ root@VPS_IP:/var/www/twittertools/deploy/
```

### 2. API service (on the VPS — the venv is created here, not uploaded)

```bash
apt update && apt install -y python3-venv   # fresh Ubuntu: python3 -m venv fails without it
cd /var/www/twittertools/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp twittertools-api.service /etc/systemd/system/   # paths inside match this layout
systemctl daemon-reload && systemctl enable --now twittertools-api
curl http://127.0.0.1:8787/health          # -> ok
```

### 3A. Apache (current VPS — static + /api/ reverse proxy)

```bash
# Replace the contents of the certbot-generated SSL vhost with our config
# (backup first). DocumentRoot is .../dist — do NOT point it at
# /var/www/twittertools, that exposes server/ and deploy/ to the web.
sudo cp /etc/apache2/sites-enabled/twittertools-le-ssl.conf \
        /etc/apache2/sites-enabled/twittertools-le-ssl.conf.bak
sudo cp /var/www/twittertools/deploy/apache-twittertools.conf \
        /etc/apache2/sites-enabled/twittertools-le-ssl.conf
sudo a2enmod proxy proxy_http headers      # mod_ssl is already enabled
sudo apache2ctl configtest                 # -> Syntax OK
sudo systemctl reload apache2
```

### 3B. nginx (alternative — static + /api/ reverse proxy)

```bash
# If Apache currently holds :80/:443, stop it first — the two servers conflict.
sudo systemctl disable --now apache2
sudo cp /var/www/twittertools/deploy/nginx-twittertools.conf /etc/nginx/sites-available/twittertools
sudo ln -sf /etc/nginx/sites-available/twittertools /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 4. HTTPS

- **Apache (3A): nothing to do.** The vhost includes the certbot-managed
  `/etc/letsencrypt/live/twittertools.com/` certificates, which renew
  automatically. Verify: `curl -I https://twittertools.com` → 200 and
  `curl -I http://twittertools.com` → 301 to HTTPS.
- **nginx (3B):** `sudo certbot --nginx -d twittertools.com -d www.twittertools.com`
  (installs the cert and auto-renews), or issue with acme.sh and wire the cert
  paths as described in the header comment of `deploy/nginx-twittertools.conf`.

> **The VPS must be able to reach `cdn.syndication.twimg.com`, `pbs.twimg.com` and
> `video.twimg.com`.** Any standard overseas VPS can; verify with
> `curl -I https://cdn.syndication.twimg.com/tweet-result?id=20`.
> Do **not** set `TT_PROXY` in the systemd unit — that's a local-dev aid only.

## Deploy gotchas (learned during the first rollout)

- **rsync: never combine multiple source dirs with `--delete`.** Trailing-slash
  sources merge into the destination root and `--delete` then treats existing
  siblings (like `dist/`) as extraneous and deletes them. Always one rsync per
  destination directory.
- **`--exclude .venv` on the server rsync is mandatory.** The venv is created
  on the VPS (step 2); without the exclude, every re-deploy's `--delete` wipes
  it and the service dies on its next restart.
- **Fresh Ubuntu needs `python3-venv`** before `python3 -m venv`, and a failed
  attempt leaves a broken half-created `.venv` — `rm -rf .venv` and recreate
  after installing the package.
- **Apache `DocumentRoot` must be `.../dist`**, not the project parent — the
  parent would publicly serve `server/` (source) and `deploy/` (configs).
- **twimg hotlink protection:** requests carrying a non-X `Referer` get 403
  from `video.twimg.com`. The backend therefore sends no Referer header at
  all — don't add one back.
- **The syndication endpoint is undocumented and has no SLA.** If the
  downloader/thread tools start failing en masse, check `fetch_syndication()`
  and the token algorithm in `server/downloader_server.py` first.
- **VPS Python may be 3.8 (EOL).** Fine today (pip resolves aiohttp 3.10.x and
  the backend is 3.8-compatible), but plan a distro/Python upgrade.

## Updating content

- Tool copy/FAQ lives directly in `src/pages/*.astro`; the homepage grid is generated
  from `src/lib/tools.ts`. Edit → `npm run build` → rsync `dist/`.
- Ad slots are placeholder `<AdSlot />` components — paste an AdSense snippet inside
  `src/components/AdSlot.astro` when approved and rebuild.
- Contact addresses `contact@` / `dmca@twittertools.com` (in `privacy.astro` / `terms.astro`)
  are live mailboxes — keep them monitored once the site is public.
- Social card: edit `scripts/gen_og.py`, run `python3 scripts/gen_og.py`.

## Launch checklist

1. **DNS** — point `twittertools.com` (+ `www`) A records at the VPS.
2. **Deploy** — follow "Deploy to the VPS" above; verify `systemctl status twittertools-api`
   and `curl http://127.0.0.1:8787/health` → `ok`.
3. **HTTPS** — the Apache vhost uses the certbot-managed certificate (renews
   automatically). Verify: `curl -I https://twittertools.com` → 200, and
   `curl -I http://twittertools.com` → 301 to HTTPS.
4. **Smoke test from an outside network** — site loads over HTTPS; paste a known video post
   into the downloader and download the smallest variant; unroll one thread.
5. **Search Console** — submit `https://twittertools.com/sitemap-index.xml` (and Bing
   Webmaster Tools). Request indexing for the homepage.
6. **Ads** — apply for AdSense once indexed; paste the snippet into `AdSlot.astro`, rebuild.
7. **Ongoing** — check the downloader against a known video tweet weekly; the syndication
   endpoint is undocumented and X can change it without notice.

## Trademark note

The site brands as **TwitterTools — tools for X (Twitter)** and everywhere states it is
*not affiliated with X Corp.* Keep that disclaimer intact, keep WHOIS current and the
site a genuine, functioning tool — that bona-fide use is the main defense in any
potential UDRP dispute over the domain.
