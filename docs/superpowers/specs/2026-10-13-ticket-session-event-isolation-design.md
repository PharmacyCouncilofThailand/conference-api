# Ticket session event isolation

Approved scope: the user requested implementation of the three fixes presented in the diagnosis: reset session selection on event changes, ignore stale session loads, and reject cross-event links in create/update APIs.

## Design

Keep existing POST/PATCH endpoints and payloads. The Tickets page clears selected IDs and displayed sessions immediately when changing event. Its session-loading effect ignores responses after event/modal changes. Only sessions returned for the current event may remain selected. New primary tickets continue selecting main sessions automatically; editing does not add unchecked main sessions. Saving and changing category wait until sessions load successfully.

The API checks both `sessionIds` and legacy `sessionId` against sessions belonging to the ticket event before any write. Missing or foreign sessions return HTTP 400 with code `INVALID_TICKET_SESSIONS` and the invalid IDs. PATCH scopes the ticket lookup and write to the URL event, returning 404 for a mismatched ticket. Omitted session fields preserve links; an empty array clears links. Existing valid payloads and response shapes remain compatible.

## Verification and limits

Regression tests execute the actual frontend component with controlled async responses and the actual Fastify routes with database methods mocked. Cover event switching, late responses, edit/duplicate, explicit deselection, create/update rejection without writes, unknown sessions, legacy fields, and URL event mismatch. Run API build, backoffice type checking, and focused tests. No dependencies, database migration, automatic cleanup of historical links, or deployment.
