---
name: security-audit
description: Security auditing for {{project.name}}, a browser-delivered web app. Covers dependency hygiene, XSS prevention, secret leakage in client bundles, validation of third-party data, CORS / mixed content, browser-storage safety, and CI workflow safety. Use when reviewing code for security vulnerabilities or setting up security guardrails.
user-invocable: false
---

# Security Audit Standards

{{sec.threatModelIntro}}

Focus areas, in priority order:

## Priority Areas

### 1. Dependency hygiene

- **Run audit on every dep change:** `{{sec.auditCmd}}` (production deps; run the dev-inclusive variant as a separate report).
- **Vet new deps:** for any package added in the diff, check on npmjs.com:
  - Weekly downloads (≥ 10k unless niche)
  - Last publish date (within 12 months)
  - Maintainer count (single-maintainer = higher risk)
  - GitHub repo activity (open issues, recent commits)
  - Transitive bloat (`pnpm why <pkg>` / `npm ls <pkg>`)
- **Flag typo-squats** — packages with names that are off-by-one from popular packages.
- **Lockfile is the source of truth.** Reject PRs that modify `package.json` without updating `{{project.lockfile}}`.

### 2. XSS prevention

- **Forbidden in JSX/templates unless explicitly justified:**
  - `dangerouslySetInnerHTML` (or the framework's raw-HTML equivalent) — must have a comment justifying it AND show input is sanitized (DOMPurify or equivalent)
  - `<svg>` constructed from variable strings
  - `innerHTML` / `outerHTML` assignments via refs
- **URL injection:** `href={...}` and `src={...}` must validate that the value is `https:` or a relative path. Never accept arbitrary strings from user input or third-party data.
- **`target="_blank"`** must include `rel="noopener noreferrer"`.
- **Markdown rendering:** if any markdown is rendered, use a sanitizing renderer (e.g., `react-markdown` with `rehype-sanitize`) — never raw HTML.

### 3. Secrets in the client bundle

- **The bundle is public.** Anything exposed via the bundler's public env mechanism (e.g. `import.meta.env.VITE_*`) ships to the browser. Treat all such env vars as public.
- **Grep the source and the build output** for likely secret patterns: `sk-`, `Bearer `, `API_KEY`, `SECRET`, `TOKEN`, `Authorization`, `AKIA[A-Z0-9]{16}`, `AIza[A-Za-z0-9_-]{35}`.
- **No private keys, tokens, or credentials should appear in the build output** after `{{project.buildCmd}}`. Inspect the production build output, not just source.
- **If you need a real secret** (e.g., a paid API key), it MUST live behind a server proxy — never in the browser.

### 4. Validation of third-party data

{{sec.dataSource}} is untrusted external input. Treat its responses as adversarial:

- Every field used downstream must be **type-narrowed** at the boundary (schema library or hand-written guards).
- **Never** pass response strings into `dangerouslySetInnerHTML`, `eval`, `new Function()`, or as a URL.
- **Reject malformed records** rather than crashing — log and skip.
- **No string concatenation into selectors or DOM APIs** (e.g., `document.querySelector("#" + record.name)` — vulnerable if `name` contains a `]`/`'`/etc.).

### 5. CORS / mixed content

- All external endpoints MUST be `https://`. Search for `http://` in source — it shouldn't appear except in localhost dev URLs.
- An endpoint that reflects `Access-Control-Allow-Origin` is usable by any origin — do not assume responses are unique to your app.
- Do not use `<script src="http://...">` or `<img src="http://...">`.
- Any external `<script>` from a CDN must carry Subresource Integrity (`integrity="sha384-..." crossorigin="anonymous"`) — without it a CDN compromise ships arbitrary code to your users. Prefer bundling over CDN scripts entirely.

### 6. localStorage / sessionStorage / IndexedDB safety

- **Never store secrets** (the storage is readable by any script on the same origin).
- **Validate on read** — storage can be tampered with. Re-narrow the type when reading; reject if the shape is wrong.
- **Use a versioned key prefix** (e.g., `app:v1:records`) so a future schema change doesn't crash users with stale data.
- **Query-cache persistence** (e.g., TanStack Query storage persisters) is fine, but ensure the persister has a key prefix and doesn't persist queries that include sensitive data.

### 7. CI workflow safety

- **No `pull_request_target` with secrets** unless every code path is read-only (this trigger runs in the context of the base branch but with PR code — a known supply-chain footgun).
- **Pin actions by SHA**, not tag (`uses: actions/checkout@<sha>`) for any action that has access to secrets or write permissions.
- **Limit `GITHUB_TOKEN` permissions** to the minimum needed (`permissions:` block at the workflow or job level).
- **Don't echo secrets** in CI logs.

## Audit Checklist

Run through this list on every review:

1. `{{sec.auditCmd}}` — note critical/high findings
2. `{{project.lockfile}}` matches `package.json` (no untracked dependency changes)
3. `git grep -E "(sk-|Bearer |API_KEY|SECRET|TOKEN|AKIA|AIza)"` — no secrets in source
4. After `{{project.buildCmd}}`, `grep -rE "(sk-|API_KEY|SECRET)" <build output dir>/` — no secrets in built output
5. `git grep dangerouslySetInnerHTML` — every hit has a justifying comment + sanitization
6. `git grep -E "target=\"_blank\""` — every hit also has `rel="noopener noreferrer"`
7. `git grep -E "http://"` — only acceptable in `localhost` dev URLs
8. The data-client module validates every external response field before returning
9. localStorage / sessionStorage usage validates types on read
