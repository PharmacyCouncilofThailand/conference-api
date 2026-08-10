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
