# AccessZ

AccessZ is a light-first accessibility auditing workspace for developers, with an optional dark theme. It includes a responsive React application and an Express API that runs real Playwright/Chromium + axe-core scans against public URLs or sanitized HTML snippets. Sample HTML is clearly identified and scanned by the same real engine; no demo findings are seeded.

Automated checks are useful evidence, not proof of full WCAG conformance. Manual review remains necessary.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+
- Chromium installed through the backend Playwright package

## Setup

```powershell
npm install
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
npm exec --workspace backend playwright install chromium
npm run dev
```

The frontend runs at [http://localhost:5173](http://localhost:5173) and binds to loopback; the API listens on loopback at [http://127.0.0.1:3001](http://127.0.0.1:3001). The frontend uses Vite's `/api` proxy by default. `VITE_API_BASE_URL` can override that value. Backend secrets and settings belong only in `backend\.env`.

## Accounts and MongoDB Atlas

Sign-up, sign-in, and protected audit APIs require a working MongoDB connection and a session secret. The backend intentionally fails closed instead of silently falling back to shared in-memory user data. With the provided blank `.env.example` values, the health endpoint and public scan-engine status remain available, but account and audit routes return `503` until configured.

1. Create a MongoDB Atlas cluster, database user, and narrowly scoped network access rule. Copy its standard connection URI into `MONGODB_URI` in `backend\.env`; keep the URI private and never put it in frontend environment variables.
2. Generate a unique session secret of at least 32 characters, for example:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

   Set the output as `SESSION_SECRET` in `backend\.env`. Do not commit `.env` or reuse this secret elsewhere.
3. Keep `FRONTEND_ORIGIN` set to the exact frontend origin. Restart the backend after configuring the values.

AccessZ stores password hashes (bcrypt), users, audits, repair/verification records, and HTTP sessions in MongoDB. Session cookies are HTTP-only, regenerate on sign-in, use same-site strict in development, and use Secure in production. Production cross-site frontend/API deployments use `SameSite=None`; browsers may block third-party cookies, so a same-site custom domain or reverse proxy is recommended. State-changing authentication requests require the exact allowed `Origin`; sign-in attempts are rate-limited. Protected resources are loaded and queried by owner ID, so another account receives no access to the record. Browser-local audit snapshots are not used for signed-in accounts.

`GET /api/health` reports database and authentication readiness without exposing connection strings or session secrets. Real Atlas connectivity, cookie behavior behind a production proxy, and deployment-specific CORS must be validated in the target environment; no Atlas URI is included in this repository.

To use a system-managed Chromium binary, set `CHROMIUM_EXECUTABLE_PATH` in the backend environment. Set `SCAN_TIMEOUT_MS` (1,000–45,000 ms) or `NAVIGATION_TIMEOUT_MS` (1,000–15,000 ms) to adjust the bounded defaults.

## Groq repair copilot

The repair copilot uses Groq's official OpenAI-compatible Chat Completions endpoint (`https://api.groq.com/openai/v1/chat/completions`) with strict JSON Schema output validated again by Zod and the scoped patch validator. The initial backend default is `GROQ_MODEL=openai/gpt-oss-120b`; this model supports Groq's documented strict structured-output mode. Model availability and account access can change, so confirm that the configured account can use it in the [Groq model catalog](https://console.groq.com/docs/models). Set a different active model only through the backend `GROQ_MODEL` environment variable. The backend never exposes `GROQ_API_KEY` to the frontend.

To enable AI suggestions:

1. Create a Groq API key in the [Groq Console](https://console.groq.com/keys).
2. Set `GROQ_API_KEY` in `backend\.env`. Optionally set `GROQ_MODEL` there; if omitted, the backend uses `openai/gpt-oss-120b`.
3. Restart the backend. Settings and the repair workspace show whether the provider is configured, available after a successful request, temporarily unavailable, or misconfigured. They never display the key.

No Groq key is required for scans or the test suite. Without a configured provider—or during transient provider/model errors—the copilot offers a deterministic safe label suggestion when an adjacent visible label gives clear context, otherwise manual guidance. Provider calls use a 15-second timeout and at most one retry for transient server/network/brief rate-limit failures. The model's JSON response is validated with Zod and a separate scoped-patch allowlist.

Only the selected finding's element and a bounded surrounding snippet are sent to Groq after the user requests a suggestion. The model is instructed to treat all supplied HTML and finding text as untrusted data, but prompt-injection resistance is not guaranteed by prompting alone; the allowlisted patch validator, explicit user review, and manual confirmation for uncertain content are required safeguards. Source snippets are not logged or retained as prompt context. AI is optional and scanning continues if the provider is missing, rate-limited, or unavailable.

Repairs require an owner-scoped HTML artifact. A pasted-HTML audit creates a versioned artifact from the sanitized submitted source and the Repair Copilot selects that associated source internally; for URL audits, findings remain evidence only and a user-controlled artifact must already exist through the artifact API. AccessZ never edits a scanned live page or constructs an editable artifact from a remote element. Artifacts are stored with MongoDB account records, limited to 300 KB, downloadable through the API, and previewed in a network-restricted sandbox. Each proposal is bound to the exact artifact version and SHA-256 patch hash; approval applies only if both still match, and MongoDB persists the patch and artifact together in a transaction. Rejection leaves the artifact untouched. A patch is marked **verified** only after a successful real rescan of the controlled artifact confirms its baseline finding is absent. Findings that remain, change, are newly introduced, or need human review are recorded distinctly. Failed scans do not update a final score. A live URL re-scan is labeled environmental and is not used to claim that the controlled patch was verified.

Verification compares deduplicated finding fingerprints based on rule ID, normalized selector context, and failure details. The follow-up includes the original WCAG level and best-practice setting. Comparison scores use actual applicable rule outcomes; incomplete, inapplicable, and untested checks are excluded, and an incomplete check is never treated as a confirmed pass. Scores are AccessZ indicators, not official WCAG ratings or legal conformance claims.

### Audit history and storage

When MongoDB is configured, audit history, repairs, verification results, and sessions persist in Atlas and are scoped to the signed-in account. The frontend displays account-backed history. The old browser-local audit-history key is cleared after a successful session check/sign-in and is not used as a fallback, avoiding cross-account exposure on shared browser profiles. Browser preferences such as theme remain local to the browser.

When MongoDB is missing or unavailable, the service reports that state and protected routes return a safe error. It does not claim that audit results were saved to durable storage.

Audit reports can be downloaded as JSON or standalone print-friendly HTML. The HTML report escapes all untrusted findings, snippets, and patch content instead of rendering submitted page markup.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite frontend and Express API |
| `npm run build` | Build/check both workspaces |
| `npm test` | Run backend and frontend unit/integration tests |
| `npm run lint` | Lint backend and frontend JavaScript |
| `npm run test:e2e --workspace frontend` | Run frontend Chromium smoke tests |

Install the frontend Playwright browser if it is not already present before running its browser smoke tests:

```powershell
npm exec --workspace frontend playwright install chromium
```

The browser E2E suite launches `backend/test/e2eServer.js`, which supplies an explicit test-only identity and in-memory repository so it can exercise the real scanner and UI without Atlas credentials. It does **not** validate MongoDB connectivity, Mongo-backed sessions, or production cookie/CORS behavior. Those require a configured deployment environment.

## Scanner behavior and boundaries

- `POST /api/audits/url` accepts public HTTP/HTTPS URLs on standard ports only. It rejects credentials, restricted IPs/hostnames, and DNS answers that include a restricted address.
- URL requests run through a per-scan proxy bound only to loopback. HTTPS CONNECT targets are converted to validated HTTPS URLs before DNS resolution; each outbound request and redirect is revalidated, and the proxy pins public addresses at connection time to prevent DNS rebinding. Browser requests, methods, transfer size, navigation, concurrency, queue depth, and overall scan time are bounded. Localhost, private, link-local, and cloud metadata destinations are blocked.
- `POST /api/audits/html` accepts at most 300,000 bytes. It removes scripts, forms, frames, links, metadata, and active navigation attributes, then serves the sanitized document from a random-token loopback origin. The isolated browser blocks all other network requests. HTML preview documents are separately sandboxed in the frontend.
- Chromium runs headlessly with a fresh context and no credentials, downloads, or service workers. Browser, proxy, preview server, and context resources are closed after scans, including cancellation and failures.
- axe-core runs WCAG-focused tags: WCAG 2.0 and 2.1 A/AA/AAA plus axe-supported WCAG 2.2 AA rules. axe-core does not expose separate WCAG 2.2 A or AAA tags in this configuration. Best-practice checks are optional. `violations`, `passes`, `incomplete`, and `inapplicable` remain separate in the response.
- HTML audits also capture forward and reverse keyboard focus sequences. Heuristic focus visibility/order observations are review candidates only, not definitive failures. The contrast utility applies the WCAG relative-luminance formula and returns unsupported/transparent/complex colors as requiring review; live scans use axe-core's color-contrast rule to avoid duplicate findings.
- The AccessZ score is not an official WCAG score. It uses unique axe passing/violating rules only: each passing rule has weight 1; failed rules use critical 5, serious 4, moderate 2, minor 1. Incomplete and inapplicable rules are excluded. If no rules are tested, the score is `null`.
- User, audit, repair, verification, and session records are stored in MongoDB and owner-scoped. Protected requests fail closed when MongoDB or the session secret is unavailable. The browser does not fall back to shared or account-unpartitioned audit snapshots.
- The API and Vite development server bind exclusively to IPv4 loopback (`127.0.0.1`); the API allows configured local frontend origins with credentials. Production deployment requires HTTPS, a valid `FRONTEND_ORIGIN`, production cookie settings, secured Atlas network access, and platform-specific Chromium validation. CORS is not authentication.

## API contract

All responses include a request ID in the body and `X-Request-Id` header. Errors use:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "The audit request is invalid.", "requestId": "...", "details": [] } }
```

| Endpoint | Behavior |
| --- | --- |
| `GET /api/health` | API and actual Chromium/axe availability |
| `POST /api/auth/register` | Create a user and start an HTTP-only session |
| `POST /api/auth/login` | Sign in by email or username; rate-limited |
| `GET /api/auth/me` | Return the current authenticated user |
| `POST /api/auth/logout` | Destroy the current session |
| `POST /api/audits/url` | Body: `{ "url", "wcagLevel", "includeBestPractices" }` |
| `POST /api/audits/html` | Body: `{ "html", "projectName", "wcagLevel", "includeBestPractices" }` |
| `GET /api/audits/` | Recent audit summaries; optional `limit` from 1 to 50 |
| `GET /api/audits/:auditId` | Full normalized result and (for HTML scans) sanitized preview |
| `GET /api/artifacts/` | List controlled artifacts belonging to the signed-in user |
| `POST /api/artifacts/` | Upload `{ "name", "html" }` (max 300 KB), or create from an owned pasted-HTML audit using `sourceAuditId` |
| `GET /api/artifacts/:artifactId` | Read one owned artifact and its version |
| `GET /api/artifacts/:artifactId/download` | Download the owned HTML artifact as an attachment |
| `GET /api/audits/:auditId/repairs` | Repair records for a baseline audit |
| `POST /api/audits/:auditId/verify` | Re-scan the controlled HTML artifact, or live URL if no controlled snapshot exists; live URL results are marked environmental |
| `POST /api/repairs/:repairId/verify` | Re-scan the exact applied repair artifact using the immutable baseline WCAG/axe configuration |
| `GET /api/audits/:auditId/verifications` | Verification attempts, including failed scans and comparison evidence |
| `GET /api/audits/:auditId/report.json` | Download report data with audit, repairs, verifications, methodology, and limitations |
| `GET /api/audits/:auditId/report.html` | Download escaped print-friendly HTML report |
| `POST /api/repairs/suggest` | Body: `{ "auditId", "artifactId", "violationId", "nodeIndex" }`; creates a proposal only when real finding evidence matches the owned controlled artifact |
| `POST /api/repairs/:repairId/apply` | Body: `{ "manualReviewConfirmed", "reviewedPatchHash", "artifactVersion" }`; checks explicit review, exact patch hash, and current artifact version before applying |
| `POST /api/repairs/:repairId/reject` | Rejects a pending suggestion without changing source |
| `POST /api/repairs/:repairId/rollback` | Restores the artifact snapshot from before an applied patch; refuses stale rollback if a later patch changed the artifact |

All audit, artifact, repair, verification, and report endpoints require an authenticated session and operate only on records owned by that account. Keep `.env` secrets private. If any real database password, session secret, or API key was shared or committed, revoke/rotate it and update the local environment; `.env.example` contains blank credential placeholders only.

## Architecture

- `frontend/`: React, Vite, React Router, Tailwind, Lucide, API client, responsive application shell, Vitest/Testing Library, and Playwright smoke tests.
- `backend/`: Express, Zod request validation, session-based authentication, MongoDB/Mongoose user-scoped repositories, Playwright/Chromium, `@axe-core/playwright`, axe result normalization/scoring, isolated preview service, SSRF-bounded proxy, and the optional Groq provider plus deterministic repair service.
- Browser scanning runs only in the backend; browser-side code contains no scanner secrets or direct target fetches.
- `backend/test/fixtures/inaccessible.html` contains deliberate accessibility failures used by the real-browser regression test.

## Implementation checklist

- [x] Responsive JavaScript frontend and Express API foundation.
- [x] Real, isolated Playwright + Chromium + axe-core scans for URLs and pasted HTML.
- [x] URL/DNS/redirect policy, request and resource limits, cancellation, and cleanup.
- [x] Real findings/evidence UI, history, JSON/HTML exports, score, and manual-review labels.
- [x] Contrast/scoring/normalization utilities, inaccessible regression fixture, and tests.
- [x] Groq-backed repair suggestions with validated output, deterministic/manual fallback, scoped patch application, and rollback.
- [x] Immutable repair baselines, real controlled-artifact rescans, finding comparison, status lifecycle, and report exports.
- [x] Loopback-only frontend/API development servers, constrained local CORS origins, and a checked-in environment template with empty secret values.
- [x] AccessZ signup/login/logout, Mongo-backed sessions, password hashing, CSRF origin checks, and owner-scoped persisted workspaces.
- [ ] Configure a real MongoDB Atlas deployment and verify production cookies, indexes, backups, and Chromium hosting.
