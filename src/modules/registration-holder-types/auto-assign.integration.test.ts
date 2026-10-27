import assert from "node:assert/strict";
import test from "node:test";

// Explicit opt-in to a disposable local PostgreSQL server with the full
// schema pushed. Never uses an existing DATABASE_URL.
const testUrl = process.env.HOLDER_AUTO_TEST_DATABASE_URL;

test("PRIS holder type auto rules and admin edits on PostgreSQL", { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "5548");
  process.env.DATABASE_URL = testUrl;
  const { db, closeDatabase } = await import("../../database/index.js");
  const { sql } = await import("drizzle-orm");
  const { applyAutoHolderType, markHolderTypeOwnerChanged } = await import("./auto-assign.js");
  const { setAdminHolderType, HolderTypeUpdateError } = await import("./admin-assign.js");

  const q = (text: string) => db.execute(sql.raw(text));
  const one = async (text: string) => ((await q(text)) as unknown as Record<string, unknown>[])[0];

  try {
    const existing = await one("SELECT count(*)::int AS n FROM events");
    assert.equal(existing.n, 0, "test database must be empty");

    await q(`
      INSERT INTO events(id,event_code,event_name,event_type,start_date,end_date) VALUES
        (2,'PRIS-2026','PRIS','multi_session',now(),now()),(1,'NPHA-2026','NPHA','single_room',now(),now());
      INSERT INTO ticket_types(id,event_id,category,name,price,quota) VALUES
        (2,2,'primary','Early Bird',1250,0),(3,2,'primary','Regular',2500,0),
        (7,2,'primary','Health Hack',500,0),(8,2,'primary','Booth',500,0),(20,1,'primary','Regular',0,0);
      INSERT INTO promo_codes(id,event_id,code,discount_type,discount_value,max_uses) VALUES
        (6,2,'MODPRIS2026','percentage',100,0),(10,2,'PRISBOOTH2026','percentage',100,0),
        (11,2,'PRISVIP2026','percentage',100,0),(9,2,'HEALTHHACK2026','percentage',100,0);
      INSERT INTO backoffice_users(id,email,password_hash,role,first_name,last_name) VALUES
        (1,'admin@example.test','x','admin','Ad','Min');
      INSERT INTO abstract_categories(id,event_id,name) VALUES (1,2,'General');
    `);
    for (let i = 1; i <= 12; i++) {
      await q(`INSERT INTO users(id,email,password_hash,role,first_name,last_name)
        VALUES (${i},'u${i}@example.test','x','pharmacist','F${i}','L${i}')`);
    }
    await q(`INSERT INTO abstracts(user_id,event_id,title,category_id,presentation_type,background,objective,methods,results,conclusion,status)
      VALUES (5,2,'T',1,'poster','b','o','m','r','c','accepted')`);

    let nextId = 100;
    async function register(opts: { user: number; ticket: number; source: string; promoId?: number; event?: number; paid?: boolean }) {
      const id = nextId++;
      let orderId = "NULL";
      if (opts.paid !== false && (opts.source === "purchase" || opts.promoId)) {
        const code = opts.promoId
          ? `(SELECT code FROM promo_codes WHERE id=${opts.promoId})` : "NULL";
        await q(`INSERT INTO orders(id,user_id,order_number,total_amount,status,promo_code_id,promo_code)
          VALUES (${id},${opts.user},'ORD-${id}',0,'paid',${opts.promoId ?? "NULL"},${code})`);
        orderId = String(id);
      }
      await q(`INSERT INTO registrations(id,reg_code,order_id,event_id,ticket_type_id,user_id,email,first_name,last_name,source)
        VALUES (${id},'REG-${id}',${orderId},${opts.event ?? 2},${opts.ticket},${opts.user},'u${opts.user}@example.test','F','L','${opts.source}')`);
      return id;
    }
    const holder = (id: number) =>
      one(`SELECT holder_type AS type, holder_type_source AS source FROM registrations WHERE id=${id}`);
    const auto = (id: number) => db.transaction((tx) => applyAutoHolderType(tx, id));

    await t.test("promo codes and plain paid tickets are assigned with audit", async () => {
      const speaker = await register({ user: 1, ticket: 3, source: "free", promoId: 6 });
      const booth = await register({ user: 2, ticket: 8, source: "free", promoId: 10 });
      const hack = await register({ user: 3, ticket: 7, source: "free", promoId: 9 });
      const participant = await register({ user: 4, ticket: 2, source: "purchase" });
      for (const id of [speaker, booth, hack, participant]) await auto(id);
      assert.deepEqual(await holder(speaker), { type: "speaker", source: "auto:v1:promo-MODPRIS2026" });
      assert.deepEqual(await holder(booth), { type: "exhibitor", source: "auto:v1:promo-PRISBOOTH2026" });
      assert.deepEqual(await holder(hack), { type: "health_hack", source: "auto:v1:promo-HEALTHHACK2026" });
      assert.deepEqual(await holder(participant), { type: "participant", source: "auto:v1:paid-no-promo-no-abstract" });
      const audit = await one(`SELECT count(*)::int AS n FROM registration_holder_type_events WHERE registration_id IN (${speaker},${booth},${hack},${participant})`);
      assert.equal(audit.n, 4);
    });

    await t.test("VIP code, abstracts and admin-free rows go to review", async () => {
      const vip = await register({ user: 6, ticket: 3, source: "free", promoId: 11 });
      const withAbstract = await register({ user: 5, ticket: 2, source: "purchase" });
      const manual = await register({ user: 7, ticket: 3, source: "manual" });
      for (const id of [vip, withAbstract, manual]) await auto(id);
      assert.deepEqual(await holder(vip), { type: null, source: "review:v1:vip-code" });
      assert.deepEqual(await holder(withAbstract), { type: null, source: "review:v1:has-abstract" });
      assert.deepEqual(await holder(manual), { type: null, source: "review:v1:no-matching-rule" });
    });

    await t.test("other events are untouched and replays never rewrite", async () => {
      const other = await register({ user: 8, ticket: 20, source: "purchase", event: 1 });
      await auto(other);
      assert.deepEqual(await holder(other), { type: null, source: null });

      const replay = await register({ user: 9, ticket: 3, source: "purchase" });
      await auto(replay);
      const first = await one(`SELECT holder_type_updated_at AS at FROM registrations WHERE id=${replay}`);
      const result = await auto(replay);
      assert.deepEqual(result, { kind: "skip", reason: "already-classified" });
      assert.deepEqual(await one(`SELECT holder_type_updated_at AS at FROM registrations WHERE id=${replay}`), first);
      const audit = await one(`SELECT count(*)::int AS n FROM registration_holder_type_events WHERE registration_id=${replay}`);
      assert.equal(audit.n, 1);
    });

    await t.test("Excel and admin decisions are never overwritten by auto rules", async () => {
      const excel = await register({ user: 10, ticket: 3, source: "purchase" });
      await q(`UPDATE registrations SET holder_type='vip', holder_type_source='excel:abc', holder_type_updated_at=now() WHERE id=${excel}`);
      assert.deepEqual(await auto(excel), { kind: "skip", reason: "already-classified" });
      assert.deepEqual(await holder(excel), { type: "vip", source: "excel:abc" });

      const cleared = await register({ user: 11, ticket: 3, source: "purchase" });
      await db.transaction((tx) => setAdminHolderType(tx, { registrationId: cleared, holderType: null, actorId: 1 }));
      assert.deepEqual(await auto(cleared), { kind: "skip", reason: "manual-source" });
      assert.deepEqual(await holder(cleared), { type: null, source: "manual:admin:1" });
    });

    await t.test("admin edit checks the value seen, records history and rejects other events", async () => {
      const id = await register({ user: 12, ticket: 3, source: "free", promoId: 11 });
      await auto(id);
      await assert.rejects(
        db.transaction((tx) => setAdminHolderType(tx, { registrationId: id, holderType: "vip", expectedHolderType: "speaker", actorId: 1 })),
        (error: unknown) => error instanceof HolderTypeUpdateError && error.code === "HOLDER_TYPE_CHANGED",
      );
      await db.transaction((tx) => setAdminHolderType(tx, { registrationId: id, holderType: "council_committee", expectedHolderType: null, actorId: 1, reason: "list" }));
      assert.deepEqual(await holder(id), { type: "council_committee", source: "manual:admin:1" });
      const last = await one(`SELECT previous_type, new_type, previous_source, actor_id, reason FROM registration_holder_type_events WHERE registration_id=${id} ORDER BY id DESC LIMIT 1`);
      assert.deepEqual(last, { previous_type: null, new_type: "council_committee", previous_source: "review:v1:vip-code", actor_id: 1, reason: "list" });

      const other = await one(`SELECT id FROM registrations WHERE event_id=1 LIMIT 1`);
      await assert.rejects(
        db.transaction((tx) => setAdminHolderType(tx, { registrationId: Number(other.id), holderType: "vip", actorId: 1 })),
        (error: unknown) => error instanceof HolderTypeUpdateError && error.code === "HOLDER_TYPE_NOT_SUPPORTED",
      );
    });

    await t.test("moving a registration to another person sends it back to review", async () => {
      const id = Number((await one(`SELECT id FROM registrations WHERE holder_type='speaker' LIMIT 1`)).id);
      await db.transaction((tx) => markHolderTypeOwnerChanged(tx, id, 1));
      assert.deepEqual(await holder(id), { type: null, source: "review:v1:owner-changed" });
      assert.deepEqual(await auto(id), { kind: "skip", reason: "owner-changed" });
      assert.deepEqual(await holder(id), { type: null, source: "review:v1:owner-changed" });
    });

    await t.test("CHECK constraint still rejects unknown holder types", async () => {
      await assert.rejects(q(`UPDATE registrations SET holder_type='invalid' WHERE id=100`), /check constraint/);
    });
  } finally {
    await closeDatabase();
  }
});
