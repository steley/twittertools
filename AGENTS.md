# Agent Workflow Notes

Notes for AI coding agents working in this repository.

## Before every push

Run the incremental delegate review and fix anything critical/high it surfaces
before committing the final push:

    ocr delegate preview --from origin/main --to HEAD   # reviewable file list
    ocr delegate rule <files>                           # rule checklists per file

Then review each diff hunk against those rules (severity: report critical/high,
silently drop low). `ocr` needs no LLM key in delegate mode — the reviewing
agent does the reading.

## Conventions

- Astro 5 static site + one tiny aiohttp backend. Deployment is manual:
  rsync `dist/` (and `server/` + `systemctl restart twittertools-api` whenever
  server code changes), served behind Cloudflare.
- No login, no cookies, no tracking — the privacy page must always match real
  behavior. Never add auth, analytics scripts, or cookies.
- Keep README/docs free of local-environment specifics (proxies, internal
  hostnames, IPs, ports other than the documented defaults).
- Contact addresses hello@ / dmca@ are live mailboxes.
- Status-URL regexes are left-anchored on purpose — lookalike hosts
  (notx.com, foo-x.com) must not parse as x.com.
- Checks: `npx astro check`, `npx vitest run` (frontend); `python -m pyflakes
  downloader_server.py mock_test.py dev_mocks.py dev_proxy.py` and
  `python mock_test.py` (backend, offline); `node scripts/smoke.mjs` (full
  stack, see the smoke job in `.github/workflows/ci.yml` for the local mock
  setup).
