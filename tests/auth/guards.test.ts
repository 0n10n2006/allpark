import { testDb, truncateAll } from "../setup/db";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { req, seedSession } from "../http/helpers";

vi.mock("@/server/db", async () => ({ db: (await import("../setup/db")).testDb }));

const { getCurrentUser, requireRole, requireUser, requireVerifiedHost, assertOwner } =
  await import("@/server/auth/guards");

beforeEach(() => truncateAll());
afterAll(() => testDb.$disconnect());

describe("guards", () => {
  test("no cookie, unknown token, or expired session resolves to null", async () => {
    expect(await getCurrentUser(req("/"))).toBeNull();
    expect(await getCurrentUser(req("/", { cookie: "authjs.session-token=nope" }))).toBeNull();
    const { user, cookie } = await seedSession();
    await testDb.session.updateMany({ where: { userId: user.id }, data: { expires: new Date(0) } });
    expect(await getCurrentUser(req("/", { cookie }))).toBeNull();
  });

  test("requireUser throws 401, requireRole throws 403 for a non-admin", async () => {
    await expect(requireUser(req("/"))).rejects.toMatchObject({ status: 401 });
    const { cookie } = await seedSession(["RENTER", "HOST"]);
    expect((await requireUser(req("/", { cookie }))).roles).toEqual(["RENTER", "HOST"]);
    await expect(requireRole("ADMIN", req("/", { cookie }))).rejects.toMatchObject({
      status: 403,
    });
  });

  test("requireVerifiedHost needs HOST role and VERIFIED status", async () => {
    const { user, cookie } = await seedSession(["RENTER", "HOST"]);
    await expect(requireVerifiedHost(req("/", { cookie }))).rejects.toMatchObject({
      status: 403,
    });
    await testDb.user.update({
      where: { id: user.id },
      data: { hostVerificationStatus: "VERIFIED" },
    });
    await expect(requireVerifiedHost(req("/", { cookie }))).resolves.toMatchObject({
      id: user.id,
    });
  });

  test("assertOwner", async () => {
    const { cookie } = await seedSession();
    const user = await requireUser(req("/", { cookie }));
    expect(() => assertOwner(user.id, user)).not.toThrow();
    expect(() => assertOwner("someone-else", user)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

test("a suspended user is treated as signed out, even with a live session", async () => {
  const { user, cookie } = await seedSession(["RENTER"]);
  await testDb.user.update({
    where: { id: user.id },
    data: { suspendedAt: new Date(), suspendedReason: "fraud review" },
  });
  expect(await getCurrentUser(req("/api/me", { cookie }))).toBeNull();
  await expect(requireUser(req("/api/me", { cookie }))).rejects.toMatchObject({ status: 401 });
});
