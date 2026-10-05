-- RETIRED MUTATION ENTRY POINT. This file now only reports scoped candidates/conflicts.
-- Supply reviewed psql -v event_id=... -v main_session_id=... -v ON_ERROR_STOP=1.
-- Reuse the same read-only inventory and target validation. No table locks or writes.
-- Enable policy/import ONLY through authenticated, audited attendance-setup API.
\ir 00_readiness.sql
