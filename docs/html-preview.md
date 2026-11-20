# HTML Preview

The file viewer's Preview of an `.html`/`.htm` file renders the page like a
browser opening it from disk: images, stylesheets, classic scripts, fonts and
media it references by relative path load from the project, `../` included.

## How it works

1. The viewer asks `POST /api/html-preview { path }` for a URL. The file must lie
   inside an allowed root (`lib/file-access.ts`) after symlinks resolve.
2. The server picks the grant root (`chooseHtmlPreviewRoot`, `lib/html-preview.ts`):
   the git checkout holding the file when an allowed root covers it, otherwise
   the narrowest allowed root holding it. Never wider than an allowed root.
3. It returns `/api/html-preview/<token>/<path relative to the root>`, built
   from the file's real directory plus the name it was opened by (a symlinked
   page keeps its name and relative files, as from `file://`). The iframe
   loads that URL (`sandbox="allow-scripts"`), so relative references resolve
   under the same token. A new file version issues a new URL and reloads.
4. `GET /api/html-preview/<token>/...` serves any file under the root
   (`app/api/html-preview/[token]/[...path]/route.ts`). HTML gets the storage
   polyfill (`lib/html-sandbox-polyfill.ts`); everything else streams with ranges.

Files reachable only as a session reference (outside every allowed root) get
403 from step 1 and preview inline from their text as before (`srcdoc`),
without their relative files.

## Security model

- The document always runs in an opaque origin: the iframe sandbox has no
  `allow-same-origin`, and every response carries `Content-Security-Policy:
  sandbox allow-scripts`, so opening the URL top-level is sandboxed too. It can
  never call Pi Web's other APIs with the user's cookie.
- Its subresource loads are therefore cross-site and carry no SameSite cookie.
  `isHtmlPreviewAssetRequest()` (`lib/request-security.ts`) lets GET on
  token paths past the cross-site check and `proxy.ts` past the password
  check; the Host check still applies. The 32-character random token is the
  authority. It was issued to a same-origin, signed-in request.
- No CORS headers: the page may embed project files but never read their bytes
  (`fetch`/XHR of a local JSON file fails, as from `file://`). Adding CORS
  would let a malicious page in a repo read and exfiltrate the project. Fonts
  are the one exception (`Access-Control-Allow-Origin: *`): `@font-face` loads
  require CORS and font bytes hold no secrets.
- Each request checks the resolved target against the root as issued (a real
  path), never re-resolving the root.
- `Referrer-Policy: no-referrer` keeps the token out of requests to other
  sites. The page's own script can still read its URL. A leaked token lets
  someone who can reach this Pi Web host read files under that root until the
  grant expires.
- Grants live in memory (`globalThis`), expire after an idle hour (each request
  renews), and are capped at 256 (least recently used dropped). A server
  restart invalidates them; reopening the preview issues a new one.
- Unknown extensions are `application/octet-stream` with `nosniff`, so no
  project file can be executed as a script or stylesheet by mistake.

## Limitations

- Module scripts (`<script type="module" src>`, `import`) always load in CORS
  mode, so local ones fail; classic `<script src>` works. Enabling them would
  make the project's JS sources readable by the page.
- HTML over 10 MB (fully loaded in Source) previews inline, without its files.
- Root-absolute references (`/img/x.png`) point at Pi Web, not the project.
- Directory URLs do not serve `index.html`.
- Pi Web sets `X-Frame-Options: SAMEORIGIN` globally, so an HTML preview that
  frames another project HTML file in a nested iframe is blocked.
- A changed image (without a change to the HTML) shows after a manual reload of
  the preview.
