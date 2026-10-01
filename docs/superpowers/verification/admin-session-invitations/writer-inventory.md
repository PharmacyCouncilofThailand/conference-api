# Admin Session Invitations — registration_sessions writer inventory

Baseline source revision: API `9fd9b0143827b89fd60907f2440df6afc62dbc77`.

This inventory records every production-source Drizzle insert found by exact search for `.insert(registrationSessions)`. Test-only raw SQL writers are excluded from production-path ownership but remain regression fixtures.

| Path | Baseline lines | Role | Planned ownership |
| --- | ---: | --- | --- |
| `src/database/migrate-sessions.ts` | 54, 109 | Historical migration/backfill writer | T08/A23: fail before new configured-session writes; preserve historical rows |
| `src/routes/registrations/quick.ts` | 287 | Quick registration automatic/explicit session linking | T08/A21: exclude/reject configured invitation session |
| `src/routes/registrations/free.ts` | 414 | Free registration automatic/explicit session linking | T08/A20: exclude/reject configured invitation session |
| `src/routes/payments/index.ts` | 1054 | Payment/order completion session linking | T08 compatibility inventory; preserve paid reconciliation and surface conflict if target is referenced |
| `src/modules/payments/registration-settlement.service.ts` | 277 | Registration settlement session linking | T08/A22: inspect snapshot compatibility; do not redesign payments |
| `src/routes/backoffice/registrations.ts` | 445 | Manual registration session writer | T08/A15: reject configured session before Registration/soldCount mutation |
| `src/routes/backoffice/registrations.ts` | 603 | Existing Backoffice add-session writer | T08/A15: reject configured session before any requested insert |
| `src/routes/backoffice/registrations.ts` | 918 | Backoffice registration/add-on flow writer | T08/A15 compatibility guard based on configured flag |
| `src/modules/session-grants/service.ts` | 252 | Existing Admin Session Grant canonical writer | T04/A08: branch configured session to invitation; ungated path remains immediate grant |

Additional mutation/read paths observed:
- `src/routes/backoffice/members.ts` deletes registration-session rows during owned member cleanup; T08 review must confirm invitation FK/audit behavior does not silently cascade.
- `src/routes/backoffice/checkins.ts` updates check-in fields on actual entitlements; must remain actual-access only.
- `src/utils/sessionEnrollment.ts`, Backoffice session/event readers, public workshop readers, and session-grant public entitlement readers count/read actual entitlements and must not count pending invitations as actual access.

Final T08/BYPASS-08 repeats this search at final source revision and maps any newly discovered writer before PASS.
