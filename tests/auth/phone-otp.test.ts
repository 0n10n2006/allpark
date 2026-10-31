import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PhoneOtpRequestResponse, PhoneOtpVerifyResponse } from "@/contracts";
import { noParams, req, seedSession } from "../http/helpers";
import { testDb, truncateAll } from "../setup/db";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { setSmsSenderForTests } = await import("@/server/auth/sms");
const { getCurrentUser } = await import("@/server/auth/guards");
const { POST: requestRoute } = await import("@/app/api/auth/phone/request/route");
const { POST: verifyRoute } = await import("@/app/api/auth/phone/verify/route");

const PHONE = "+919812345678";
let sent: { to: string; text: string }[] = [];

beforeEach(async () => {
  await truncateAll();
  sent = [];
  setSmsSenderForTests({ send: async (to, text) => void sent.push({ to, text }) });
});
afterEach(() => setSmsSenderForTests(undefined));
afterAll(() => testDb.$disconnect());

const lastCode = () => sent.at(-1)!.text.match(/^(\d{6}) /)![1];

const requestCode = (phone = PHONE, ip = "203.0.113.7") =>
  requestRoute(
    req("/api/auth/phone/request", {
      method: "POST",
      body: { phone },
      headers: { "x-real-ip": ip },
    }),
    noParams,
  );
const verify = (code: string, cookie?: string, phone = PHONE) =>
  verifyRoute(
    req("/api/auth/phone/verify", { method: "POST", body: { phone, code }, cookie }),
    noParams,
  );
const cookieFrom = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

describe("POST /api/auth/phone/request", () => {
  test("normalises the number, texts a 6-digit code, and stores only a hash", async () => {
    const res = await requestCode("98123 45678");
    expect(res.status).toBe(200);
    expect(PhoneOtpRequestResponse.parse(await res.json())).toEqual({
      sent: true,
      expiresInSeconds: 600,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PHONE);
    const code = lastCode();
    const rows = await testDb.verificationToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe(`phone:${PHONE}`);
    expect(rows[0].token).not.toContain(code);
  });

  test("a new request replaces the old code", async () => {
    await requestCode();
    const first = lastCode();
    await requestCode();
    expect(await testDb.verificationToken.count()).toBe(1);
    if (first !== lastCode()) expect((await verify(first)).status).toBe(422);
  });

  test("rejects non-Indian numbers with 400", async () => {
    expect((await requestCode("+14155550123")).status).toBe(400);
    expect((await requestCode("12345")).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("over the per-number cap the response is identical but nothing is sent", async () => {
    for (let i = 0; i < 5; i++) await requestCode(PHONE, `198.51.100.${i}`);
    expect(sent).toHaveLength(5);
    const res = await requestCode(PHONE, "198.51.100.99");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, expiresInSeconds: 600 });
    expect(sent).toHaveLength(5);
  });

  test("503 when no SMS provider is configured (production default)", async () => {
    setSmsSenderForTests(null);
    const res = await requestCode();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("sms_not_configured");
  });
});

describe("POST /api/auth/phone/verify (signed out)", () => {
  test("new number: creates a verified account and sets a working session cookie", async () => {
    await requestCode();
    const res = await verify(lastCode());
    expect(res.status).toBe(200);
    const body = PhoneOtpVerifyResponse.parse(await res.json());
    expect(body).toMatchObject({ result: "signed_in", isNewUser: true });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(
      /^authjs\.session-token=[0-9a-f]{64}; Path=\/; Expires=.+; HttpOnly; SameSite=Lax$/,
    );
    const me = await getCurrentUser(req("/", { cookie: cookieFrom(res) }));
    expect(me?.id).toBe(body.userId);
    const user = await testDb.user.findUniqueOrThrow({ where: { id: body.userId } });
    expect(user.phone).toBe(PHONE);
    expect(user.phoneVerifiedAt).not.toBeNull();
  });

  test("codes are single use", async () => {
    await requestCode();
    const code = lastCode();
    expect((await verify(code)).status).toBe(200);
    expect((await verify(code)).status).toBe(422);
  });

  test("returning number signs in to the same account", async () => {
    await requestCode();
    const first = PhoneOtpVerifyResponse.parse(await (await verify(lastCode())).json());
    await requestCode();
    const again = PhoneOtpVerifyResponse.parse(await (await verify(lastCode())).json());
    expect(again).toEqual({ userId: first.userId, result: "signed_in", isNewUser: false });
    expect(await testDb.user.count()).toBe(1);
  });

  test("wrong and expired codes → 422 with no session", async () => {
    await requestCode();
    const code = lastCode();
    const wrong = code === "000000" ? "000001" : "000000";
    const res = await verify(wrong);
    expect(res.status).toBe(422);
    expect(res.headers.get("set-cookie")).toBeNull();
    await testDb.verificationToken.updateMany({ data: { expires: new Date(Date.now() - 1000) } });
    expect((await verify(code)).status).toBe(422);
    expect(await testDb.session.count()).toBe(0);
  });

  test("too many wrong guesses burn the code, even the right one afterwards", async () => {
    await requestCode();
    const code = lastCode();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(wrong)).status).toBe(422);
    expect((await verify(code)).status).toBe(429);
    expect(await testDb.verificationToken.count()).toBe(0);
  });

  test("a number another account only typed in (unverified) is not a login key", async () => {
    const squatter = await seedSession();
    await testDb.user.update({ where: { id: squatter.user.id }, data: { phone: PHONE } });
    await requestCode();
    const body = PhoneOtpVerifyResponse.parse(await (await verify(lastCode())).json());
    expect(body.userId).not.toBe(squatter.user.id);
    expect(body.isNewUser).toBe(true);
    const s = await testDb.user.findUniqueOrThrow({ where: { id: squatter.user.id } });
    expect(s.phone).toBeNull();
  });
});

describe("POST /api/auth/phone/verify (signed in)", () => {
  test("verifies the number on the caller's account without a new session", async () => {
    const me = await seedSession();
    await testDb.user.update({ where: { id: me.user.id }, data: { phone: PHONE } });
    await requestCode();
    const res = await verify(lastCode(), me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ userId: me.user.id, result: "verified", isNewUser: false });
    const u = await testDb.user.findUniqueOrThrow({ where: { id: me.user.id } });
    expect(u.phoneVerifiedAt).not.toBeNull();
    expect(await testDb.auditLog.count({ where: { action: "user.phone_verified" } })).toBe(1);
  });

  test("409 when another account already verified the number", async () => {
    const owner = await seedSession();
    await testDb.user.update({
      where: { id: owner.user.id },
      data: { phone: PHONE, phoneVerifiedAt: new Date() },
    });
    const me = await seedSession();
    await requestCode();
    const res = await verify(lastCode(), me.cookie);
    expect(res.status).toBe(409);
    expect((await res.json()).error.details).toEqual({ reason: "phone_in_use" });
  });

  test("takes over an unverified claim from another account", async () => {
    const squatter = await seedSession();
    await testDb.user.update({ where: { id: squatter.user.id }, data: { phone: PHONE } });
    const me = await seedSession();
    await requestCode();
    expect((await verify(lastCode(), me.cookie)).status).toBe(200);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: me.user.id } })).phone).toBe(PHONE);
    expect(
      (await testDb.user.findUniqueOrThrow({ where: { id: squatter.user.id } })).phone,
    ).toBeNull();
  });
});
