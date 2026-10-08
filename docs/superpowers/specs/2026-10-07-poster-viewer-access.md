# Poster viewer access

Approved in chat on 2026-10-07. Organizer and reviewer are read-only viewers of received Posters within assigned PRIS-2026 events. Received means a successful current upload exists, including Posters with open or expired revision requests. Admin behavior remains unchanged except that the received tab now filters correctly.

API list filtering happens before counts and pagination. Non-admin detail reads of unsubmitted works return 404. Verification snapshots, match results, certification, and email information are removed from non-admin responses. Email batch and settings history reads require admin. Viewer audit history allows revision creation/cancellation; revision creation snapshots exclude email job IDs. Successful upload history remains visible in the existing file history.

Frontend exposes only the received tab and hides verification, certification, emails and administrative histories for viewers. Existing admin-only mutation guards remain. Verify with API reader regression tests, actual component render tests, TypeScript and focused ESLint.
