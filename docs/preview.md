# Browser Tab (Local-Service Preview)

The right panel's browser tab opens services of the Pi Web machine
(`localhost:5173`, `127.0.0.1:3000`, a bare `5173`) inside Pi Web. Open it from
the globe button next to the terminal button in the sidebar, or click a local
address in a chat reply (a link or inline code such as `http://localhost:5173`).
Other addresses stay normal links.

## How it reaches the service

- **Browser on the Pi Web machine** (page host is `localhost`/`127.x`/`[::1]`):
  the frame loads the address directly. No setup.
- **Remote browser** (Tailscale, LAN): the frame goes through the preview proxy,
  a second HTTP listener inside Pi Web on `127.0.0.1:$PI_WEB_PREVIEW_PORT`.
  The page loads, renders, and runs in your browser; Pi Web only relays bytes,
  including WebSockets (dev-server hot reload).

## Remote setup (once)

```bash
# Pi Web server environment (systemd unit, shell profile, or .env.development.local)
PI_WEB_PREVIEW_PORT=30144
PI_WEB_PREVIEW_URL=https://nuc.example.ts.net:10454

# Expose that port over HTTPS on the tailnet
tailscale serve --bg --https=10454 http://127.0.0.1:30144
```

Restart Pi Web after changing the variables. `PI_WEB_PREVIEW_URL` must use the
same hostname as Pi Web itself (only the port differs), and that hostname must
be allowed (`PI_WEB_ALLOWED_HOSTS`). Run one proxy port per Pi Web instance.

## Boundaries

- Targets are loopback only (`localhost`, `127.0.0.0/8`, `[::1]`; `0.0.0.0` maps
  to `127.0.0.1`). The proxy refuses to target itself.
- Pi Web instances (e.g. a dev server on another port) can be previewed, so
  their UI can be checked without exposing each port over Tailscale. Accepted
  trade-off: any previewed page can switch the target, so script running in a
  previewed page can reach a Pi Web's API (passwordless setups).
- The proxy requires Pi Web's login cookie when `PI_WEB_PASSWORD` is set, checks
  the Host header like Pi Web, and refuses cross-site requests and foreign
  `Origin`s. Pi Web's cookie is stripped before forwarding; upstream attempts to
  set it are dropped.
- Its own port gives previewed pages an origin apart from Pi Web's. Because they
  are still same-site, Pi Web's API rejects `Sec-Fetch-Site: same-site` and its
  pages send `X-Frame-Options: SAMEORIGIN`.
- Responses lose `X-Frame-Options`/`frame-ancestors` so they can be framed; the
  frame is sandboxed without top navigation.

## Caching (stale CSS)

- Responses without `Cache-Control` or `Expires` get `Cache-Control: no-cache`.
  Servers like `python -m http.server` or Django's send only `Last-Modified`, and
  browsers then guess a lifetime and keep edited CSS. Revalidation costs a 304;
  explicit rules (Vite's hashed `immutable` deps) pass through.
- "Open in new window" is the hard reload: it goes through the proxy with
  `hard=1`, whose redirect sends `Clear-Site-Data: "cache"`. There is no in-frame
  hard reload because Chrome keeps the frame's subresources in its in-memory
  cache for the life of the Pi Web tab, even after that header (verified on
  Chrome 149: disk cache cleared, frame still served the old file).
- A browser on the Pi Web machine loads pages directly, so neither applies;
  use the new window and Ctrl+Shift+R.

## Fill the page

The file panel's maximize button covers the whole Pi Web page (see `docs/ui.md`, File panel); the browser tab keeps its page because only CSS changes.

## Mobile

The panel is full screen on phones. The address field is 16px on touch screens
so iOS does not zoom into it. A home-screen app (PWA) opens new windows in
Safari, which has its own cookies: with `PI_WEB_PASSWORD` set, sign in there once.

## Limits

- One previewed address per Pi Web server at a time; opening another replaces it
  (also in a window opened with "Open in new window").
- The address bar shows the address you opened, not in-page navigation; Reload
  reopens that address (normal reload, cached files may be reused).
- Remote pages that call another local port directly (a hardcoded
  `http://localhost:8000` API) fail, because that request runs in your browser.
  Same-origin `/api` proxies in the dev server work.
- Redirects back from external sites (OAuth) are cross-site and refused.
