import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, truncateAll } from "../setup/db";
import { req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { runOnce } = await import("@/server/jobs");
const { notify, cancelScheduled } = await import("@/server/notifications");
const { setEmailSender } = await import("@/server/notifications/email");
const { templates } = await import("@/server/notifications/templates");
const inbox = await import("@/app/api/notifications/route");
const read = await import("@/app/api/notifications/[id]/read/route");

const sent: { notificationId: string; to: string }[] = [];
const recorder = { send: async (m: { notificationId: string; to: string }) => void sent.push(m) };

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
  setEmailSender(recorder);
});
afterAll(async () => {
  setEmailSender(null);
  await testDb.$disconnect();
});

const booking = () => ({
  bookingId: crypto.randomUUID(),
  listingTitle: "Covered spot near Koramangala",
  startAt: "2026-10-20T04:30:00Z",
  endAt: "2026-10-20T08:30:00Z",
});
const makeAllDue = () =>
  testDb.job.updateMany({
    where: { status: "PENDING" },
    data: { runAt: new Date(Date.now() - 1000) },
  });
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("notify + delivery", () => {
  test("the same idempotencyKey twice → one row, one job, one send", async () => {
    const { user } = await seedSession();
    const p = booking();
    const [a, b] = await Promise.all([
      notify(user.id, "BOOKING_CONFIRMED_RENTER", p, { idempotencyKey: "k1" }),
      notify(user.id, "BOOKING_CONFIRMED_RENTER", p, { idempotencyKey: "k1" }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await testDb.notification.count()).toBe(1);
    expect(await testDb.job.count()).toBe(1);

    await runOnce("w");
    await notify(user.id, "BOOKING_CONFIRMED_RENTER", p, { idempotencyKey: "k1" });
    await runOnce("w");
    expect(sent).toHaveLength(1);
    expect(await testDb.notification.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "SENT",
    });
  });

  test("a scheduled notification isn't delivered or shown before scheduledAt", async () => {
    const { user, cookie } = await seedSession();
    const later = await notify(
      user.id,
      "SESSION_ENDING",
      { ...booking(), minutesLeft: 30 },
      {
        idempotencyKey: "later",
        scheduledAt: new Date(Date.now() + 3600_000),
      },
    );
    await notify(user.id, "ARRIVAL_UPCOMING", booking(), { idempotencyKey: "now" });

    expect(await runOnce("w")).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(sent).toHaveLength(1);
    const body = await (await inbox.GET(req("/api/notifications", { cookie }), noParams)).json();
    expect(body.items).toHaveLength(1);
    expect(body.unreadCount).toBe(1);

    await testDb.notification.update({
      where: { id: later.id },
      data: { scheduledAt: new Date(Date.now() - 1000) },
    });
    await makeAllDue();
    expect(await runOnce("w")).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(sent.map((m) => m.notificationId)).toContain(later.id);
  });

  test("a failing sender is retried, then the notification goes FAILED", async () => {
    const { user, cookie } = await seedSession();
    setEmailSender({
      send: async () => {
        throw new Error("provider down for someone@example.com");
      },
    });
    const n = await notify(
      user.id,
      "REFUND_UPDATE",
      {
        bookingId: crypto.randomUUID(),
        status: "PROCESSING",
        amountPaise: 12_500,
      },
      { idempotencyKey: "fail" },
    );

    for (let i = 1; i <= 5; i++) {
      await makeAllDue();
      expect(await runOnce("w")).toMatchObject({ claimed: 1, [i < 5 ? "retried" : "dead"]: 1 });
      const row = await testDb.notification.findUniqueOrThrow({ where: { id: n.id } });
      expect(row).toMatchObject({ attempts: i, status: i < 5 ? "PENDING" : "FAILED" });
      expect(row.lastError).toBe("Email send failed");
    }
    expect(await testDb.job.findFirstOrThrow()).toMatchObject({ status: "DEAD" });
    // In-app is always on, even when email failed.
    const body = await (await inbox.GET(req("/api/notifications", { cookie }), noParams)).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([n.id]);
  });

  test("cancelScheduled prevents delivery", async () => {
    const { user, cookie } = await seedSession();
    const p = booking();
    for (const m of [30, 10] as const)
      await notify(
        user.id,
        "SESSION_ENDING",
        { ...p, minutesLeft: m },
        {
          idempotencyKey: `booking:${p.bookingId}:ending:${m}`,
          scheduledAt: new Date(Date.now() + 60_000),
        },
      );
    expect(await cancelScheduled(`booking:${p.bookingId}:`)).toBe(2);

    await testDb.notification.updateMany({ data: { scheduledAt: new Date(Date.now() - 1000) } });
    await makeAllDue();
    expect(await runOnce("w")).toMatchObject({ claimed: 2, succeeded: 2 });
    expect(sent).toHaveLength(0);
    expect(await testDb.notification.count({ where: { status: "CANCELLED" } })).toBe(2);
    const body = await (await inbox.GET(req("/api/notifications", { cookie }), noParams)).json();
    expect(body.items).toHaveLength(0);
  });

  test("email opt-out still delivers in-app; reminders follow sessionReminders", async () => {
    const { user } = await seedSession();
    await testDb.user.update({
      where: { id: user.id },
      data: { preferences: { notifications: { sessionReminders: false } } },
    });
    await notify(
      user.id,
      "SESSION_ENDING",
      { ...booking(), minutesLeft: 10 },
      { idempotencyKey: "r" },
    );
    await notify(user.id, "BOOKING_CONFIRMED_RENTER", booking(), { idempotencyKey: "c" });
    await runOnce("w");
    expect(sent).toHaveLength(1);
    expect(await testDb.notification.count({ where: { status: "SENT" } })).toBe(2);
  });
});

describe("privacy", () => {
  test("booking-confirmed previews carry no address or phone", async () => {
    const { user, cookie } = await seedSession();
    const leaky = {
      ...booking(),
      address: "42 MG Road, Bengaluru 560001",
      accessInstructions: "Gate code 4321",
      hostPhone: "+919876543210",
    };
    await notify(user.id, "BOOKING_CONFIRMED_RENTER", leaky, { idempotencyKey: "p" });
    const stored = JSON.stringify(await testDb.notification.findFirstOrThrow());
    const rendered = templates.BOOKING_CONFIRMED_RENTER.render(
      templates.BOOKING_CONFIRMED_RENTER.schema.parse(leaky),
    );
    const res = JSON.stringify(
      await (await inbox.GET(req("/api/notifications", { cookie }), noParams)).json(),
    );
    for (const text of [stored, JSON.stringify(rendered), res])
      for (const secret of ["MG Road", "4321", "9876543210"]) expect(text).not.toContain(secret);
    expect(rendered.body).toContain("IST");
  });
});

describe("inbox API", () => {
  test("another user can't read or mark my notification", async () => {
    const me = await seedSession();
    const other = await seedSession();
    const n = await notify(me.user.id, "ARRIVAL_UPCOMING", booking(), { idempotencyKey: "mine" });

    const theirs = await (
      await inbox.GET(req("/api/notifications", { cookie: other.cookie }), noParams)
    ).json();
    expect(theirs).toMatchObject({ items: [], unreadCount: 0 });

    const markPath = `/api/notifications/${n.id}/read`;
    const denied = await read.POST(
      req(markPath, { method: "POST", cookie: other.cookie }),
      idParams(n.id),
    );
    expect(denied.status).toBe(404);
    expect(
      (await testDb.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt,
    ).toBeNull();

    const ok = await read.POST(
      req(markPath, { method: "POST", cookie: me.cookie }),
      idParams(n.id),
    );
    expect(await ok.json()).toEqual({ ok: true });
    const mine = await (
      await inbox.GET(req("/api/notifications", { cookie: me.cookie }), noParams)
    ).json();
    expect(mine.unreadCount).toBe(0);
    expect(mine.items[0].readAt).not.toBeNull();
  });

  test("paginates newest first with a cursor", async () => {
    const { user, cookie } = await seedSession();
    for (let i = 0; i < 3; i++)
      await notify(user.id, "ARRIVAL_UPCOMING", booking(), { idempotencyKey: `n${i}` });
    const first = await (
      await inbox.GET(req("/api/notifications?limit=2", { cookie }), noParams)
    ).json();
    expect(first.items).toHaveLength(2);
    const second = await (
      await inbox.GET(
        req(`/api/notifications?limit=2&cursor=${first.nextCursor}`, { cookie }),
        noParams,
      )
    ).json();
    expect(second).toMatchObject({ nextCursor: null, unreadCount: 3 });
    expect(second.items).toHaveLength(1);
    const bad = await inbox.GET(req("/api/notifications?cursor=nope", { cookie }), noParams);
    expect(bad.status).toBe(400);
  });
});
