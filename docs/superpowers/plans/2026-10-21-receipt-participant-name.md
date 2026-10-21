# Receipt participant name implementation plan

**Goal:** Show `ชื่อผู้เข้าร่วมงาน : <firstName lastName>` below the registration fee description, using the registration linked by order ID.

**Architecture:** Extend the existing receipt registration query with firstName and lastName, pass an optional participantName to the PDF service, and append it only to ticket descriptions. Keep recipient and tax invoice information independent. Omit the participant line when no linked registration exists; do not substitute the buyer's name.

**Tech Stack:** TypeScript, Drizzle ORM, React PDF, Node test runner.

## Task 1: Add participant name to receipts

- [x] Add tests in `src/services/receiptPdf.test.ts` for a registration name different from buyer and tax recipient, unchanged add-on names, missing registration, and single-page PDF rendering.
- [x] Run `node --import tsx --test src/services/receiptPdf.test.ts` and confirm the new assertions fail before implementation.
- [x] Add `participantName?: string` to ReceiptData in `src/services/receiptPdf.ts`. Trim it and append `\nชื่อผู้เข้าร่วมงาน : ${participantName}` to ticket descriptions only when present.
- [x] In `src/routes/payments/index.ts`, extend the query filtered by `registrations.orderId = order.id` to select firstName and lastName. Pass the joined name as participantName, or undefined if no registration exists.
- [x] Run the focused receipt tests and `npm run build`.
- [x] Regenerate the sample receipt with a fictional participant name and inspect the rendered A4 page.

