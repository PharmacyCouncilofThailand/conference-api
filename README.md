# ACCP API

Backend API server with embedded database for ACCP Conference.

## Quick Start

```bash
npm install --legacy-peer-deps
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
npm run dev
```

On Windows PowerShell, set `PYTHAINLP_PYTHON=.venv\Scripts\python.exe` in
`.env`. On Linux/macOS, create the environment with `python3 -m venv .venv`
and set `PYTHAINLP_PYTHON=.venv/bin/python`. The API warms the pinned
PyThaiNLP 5.3.4 worker before accepting traffic and fails startup if the
authoritative word counter is unavailable.

## Available Scripts

| Command               | Description                          |
| --------------------- | ------------------------------------ |
| `npm run dev`         | Start development server (port 3002) |
| `npm run build`       | Build for production                 |
| `npm run start`       | Start production server              |
| `npm run db:generate` | Generate database migrations         |
| `npm run db:push`     | Push schema to database              |
| `npm run db:studio`   | Open Drizzle Studio                  |
| `npm run db:seed`     | Seed database with initial data      |
| `npm run test:team-registrations` | Run Team Registration unit/contract tests |
| `npm run test:team-registrations:integration` | Run guarded tests against `TEST_DATABASE_URL` |
| `npm run jobs:team-registrations:prod` | Run the compiled Team Registration worker |
| `npm run jobs:team-registrations:prod:once` | Run one compiled worker cycle |
| `npm run jobs:team-registrations:prod:health` | Check the compiled worker heartbeat |
| `npm run test:session-grants` | Run Admin Session Grants unit/contract tests without DB/provider |
| `npm run test:session-grants:integration` | Run guarded Admin Session Grants integration tests against `TEST_DATABASE_URL` |
| `npm run jobs:session-grants:prod` | Run the compiled Session Grant email worker |
| `npm run jobs:session-grants:prod:once` | Run one compiled Session Grant worker claim cycle |
| `npm run jobs:session-grants:prod:health` | Inspect Session Grant backlog/expired-lease health |

## Environment Variables

Copy `.env.example` to `.env` and update values:

```
DATABASE_URL=postgresql://user:password@localhost:5432/accp_db
JWT_SECRET=your-secret-key
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
PYTHAINLP_PYTHON=.venv\Scripts\python.exe
PYTHAINLP_TIMEOUT_MS=5000
```

### Production values when frontend is on Netlify

If `accp-web` and `accp-backoffice` are deployed on Netlify, ensure these are set in API hosting:

```
CORS_ORIGIN=https://<web-domain>,https://<backoffice-domain>
BASE_URL=https://<web-domain>
API_BASE_URL=https://<api-domain>
```

- `CORS_ORIGIN` must include both frontend domains (comma-separated)
- `BASE_URL` is used for links in emails
- `API_BASE_URL` is used for receipt/download links and should be `https` in production

## Team Registration payment operations

Team Registration uses its own Pay Solutions credentials and a deployment-owned
`TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE`. The enabled Event configuration
must use that same profile. Production URLs must be HTTPS, provider redirects are
not followed during inquiry, and provider test-complete statuses are always
rejected in `NODE_ENV=production`.

The API and payment worker are separate production processes. Build once, then run:

```bash
npm run start
npm run jobs:team-registrations:prod
```

When both processes use the production Docker image, leave `SERVICE_ROLE=api` on
the HTTP service and set `SERVICE_ROLE=worker` on the worker command override so
the image healthcheck validates its database activity pulse instead of port 3002.
The container check ignores operational `lastErrorCode` values; those remain
visible through `GET /health` and external alerts without restarting a live worker.

`GET /health` reports `worker.teamRegistrations.status` as `healthy`, `stale`, or
`disabled`. Keep `TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED=false` until the
payment retry migrations are installed, the worker is healthy, and staging has
verified retry, winner, duplicate-payment, refund, and expiry behavior. Full
preflight, deploy, rollback, and duplicate-refund procedures are in
[`sql/team-registration-setup/README.md`](sql/team-registration-setup/README.md).

## Admin Session Grant email operations

Admin Session Grant email delivery is a separate durable worker process. Build the
same API image, then run `npm run jobs:session-grants:prod` under the deployment's
process/container supervisor with `SERVICE_ROLE=session-grant-worker`. The API
must remain a separate process; API uptime is not worker-health evidence.

The worker claims one email at a time. While work exists it waits 700 ms between
claims; an empty queue is polled every 5 seconds. `ADMIN_SESSION_GRANTS_ENABLED`
must be `true` for new sends. `SESSION_GRANT_EMAIL_TIMEOUT_MS` defaults to 30000.
SIGTERM/SIGINT stops new claims after the current provider call returns, then the
database connection closes. A replacement worker uses the durable lease/attempt
state; it must not blindly replay an item left in `sending`.

Use `npm run jobs:session-grants:prod:health` to inspect pending count, sending
count, unknown count, oldest pending age, and expired sending leases. A non-zero
expired-lease count makes the health command fail. Process supervision must also
alert when the worker process/container itself is stopped. Provider outage does
not roll back already committed grants; inspect durable attempts before retrying,
and require explicit acknowledgement before retrying an `unknown` delivery.

## Project Structure

```
accp-api/
├── src/
│   ├── index.ts        # Main entry point
│   ├── database/       # Database schema & connection
│   ├── routes/         # API routes
│   ├── schemas/        # Zod validation schemas
│   └── services/       # Business logic
├── drizzle/            # Database migrations
└── package.json
```

## API Endpoints

- Health: `GET /health`
- Auth: `POST /auth/login`, `POST /auth/register`
- Backoffice: `/api/backoffice/*`
- Public: `/api/speakers`, `/api/abstracts`
