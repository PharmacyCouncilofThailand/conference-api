# Session email preview

Approved in chat: show a read-only preview before sending session emails, one recipient at a time with previous/next controls and a final send-all confirmation.

Both the bulk registrations screen and individual registration screen use the same dialog. Preview uses the real invitation or grant template, shows recipient and subject, and excludes ineligible recipients. Preview performs reads only and does not issue response tokens, create grants or queue mail. Links in the sandboxed preview are disabled.

The reviewed session and registration IDs remain fixed while the dialog is open. Final confirmation submits only the recipients shown in the preview, excluding skipped registrations. Closing returns to selection without sending. Loading, retry, error and empty states are explicit; send is disabled until a nonempty preview is available. Final confirmation uses existing grant creation and rechecks eligibility, capacity and deadlines. Network retries preserve the existing idempotency key.

No schema migration, dependency, email editor or delivery-system changes. Preview is advisory; recipient eligibility and session details can change before final confirmation.
