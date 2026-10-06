import type {
  CreateVehicleBody,
  Preferences,
  Profile,
  UpdatePreferencesBody,
  UpdateProfileBody,
  UpdateVehicleBody,
  Vehicle,
} from "@/contracts";
import { Preferences as PreferencesSchema } from "@/contracts";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { audit } from "@/server/http/audit";
import { HttpError } from "@/server/http/errors";

// FR-01. Every function acts on `userId` only; callers pass the signed-in user's id.

// ── Validation the contracts leave loose ──

/** Indian mobile in E.164: +91 then 10 digits starting 6-9. */
const INDIA_PHONE = /^\+91[6-9]\d{9}$/;
/** State code, RTO 1-2 digits, series 0-3 letters, number 1-4 digits (MH12AB1234, DL3CAB1). */
const STANDARD_REG = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
/** Bharat series: year, BH, 4 digits, 1-2 letters (22BH1234AB). */
const BH_REG = /^\d{2}BH\d{4}[A-Z]{1,2}$/;

/** Input is already uppercased and space-stripped by the contract. */
export function assertIndianRegistration(reg: string) {
  if (!STANDARD_REG.test(reg) && !BH_REG.test(reg))
    throw new HttpError("unprocessable", "Not a valid Indian registration number", [
      { path: ["registration"], message: "e.g. MH12AB1234 or 22BH1234AB" },
    ]);
}

// ── Profile ──

const profileSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  image: true,
  roles: true,
  hostVerificationStatus: true,
  deletionRequestedAt: true,
} as const;

type ProfileRow = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

const toProfile = (u: ProfileRow): Profile => ({
  ...u,
  deletionRequestedAt: u.deletionRequestedAt?.toISOString() ?? null,
});

export async function getProfile(userId: string): Promise<Profile> {
  return toProfile(
    await db.user.findUniqueOrThrow({ where: { id: userId }, select: profileSelect }),
  );
}

export async function updateProfile(userId: string, body: UpdateProfileBody): Promise<Profile> {
  const data: Prisma.UserUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.phone !== undefined) {
    if (body.phone !== null && !INDIA_PHONE.test(body.phone))
      throw new HttpError("unprocessable", "Phone must be an Indian mobile, e.g. +919812345678", [
        { path: ["phone"], message: "Indian mobile in E.164" },
      ]);
    const current = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phone: true },
    });
    if (current.phone !== body.phone) {
      data.phone = body.phone;
      data.phoneVerifiedAt = null;
    }
  }
  return toProfile(await db.user.update({ where: { id: userId }, data, select: profileSelect }));
}

// ── Preferences ──

const DEFAULT_PREFERENCES: Preferences = {
  defaultVehicleId: null,
  notifications: { email: true, inApp: true, sessionReminders: true, marketing: false },
};

function readPreferences(stored: Prisma.JsonValue | null): Preferences {
  const s = (stored ?? {}) as Partial<Preferences>;
  const merged = {
    ...DEFAULT_PREFERENCES,
    ...s,
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...s.notifications },
  };
  const parsed = PreferencesSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_PREFERENCES;
}

export async function getPreferences(userId: string): Promise<Preferences> {
  const u = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { preferences: true },
  });
  return readPreferences(u.preferences);
}

export async function updatePreferences(
  userId: string,
  body: UpdatePreferencesBody,
): Promise<Preferences> {
  if (body.defaultVehicleId) await findOwnVehicle(userId, body.defaultVehicleId);
  const current = await getPreferences(userId);
  const next: Preferences = {
    defaultVehicleId:
      body.defaultVehicleId === undefined ? current.defaultVehicleId : body.defaultVehicleId,
    notifications: { ...current.notifications, ...body.notifications },
  };
  await db.user.update({ where: { id: userId }, data: { preferences: next } });
  return next;
}

// ── Vehicles ──

const vehicleSelect = {
  id: true,
  registration: true,
  type: true,
  nickname: true,
  heightCm: true,
  widthCm: true,
  lengthCm: true,
} as const;

/** Another user's (or a deleted) vehicle is indistinguishable from a missing one: 404. */
async function findOwnVehicle(userId: string, id: string) {
  const v = await db.vehicle.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true },
  });
  if (!v) throw new HttpError("not_found", "Vehicle not found");
  return v;
}

export async function listVehicles(userId: string): Promise<Vehicle[]> {
  return db.vehicle.findMany({
    where: { userId, deletedAt: null },
    select: vehicleSelect,
    orderBy: { createdAt: "asc" },
  });
}

export async function createVehicle(userId: string, body: CreateVehicleBody): Promise<Vehicle> {
  assertIndianRegistration(body.registration);
  const fields = {
    type: body.type,
    nickname: body.nickname ?? null,
    heightCm: body.heightCm ?? null,
    widthCm: body.widthCm ?? null,
    lengthCm: body.lengthCm ?? null,
  };
  // Re-adding a soft-deleted registration restores that row (@@unique([userId, registration])).
  const restored = await db.vehicle.updateManyAndReturn({
    where: { userId, registration: body.registration, deletedAt: { not: null } },
    data: { ...fields, deletedAt: null },
    select: vehicleSelect,
  });
  if (restored[0]) return restored[0];
  return db.vehicle.create({
    data: { ...fields, userId, registration: body.registration },
    select: vehicleSelect,
  });
}

export async function updateVehicle(
  userId: string,
  id: string,
  body: UpdateVehicleBody,
): Promise<Vehicle> {
  if (body.registration !== undefined) assertIndianRegistration(body.registration);
  await findOwnVehicle(userId, id);
  return db.vehicle.update({ where: { id }, data: body, select: vehicleSelect });
}

/** Soft delete when bookings or monthly agreements reference the vehicle; else hard delete. */
export async function deleteVehicle(userId: string, id: string) {
  await findOwnVehicle(userId, id);
  const [bookings, monthly] = await Promise.all([
    db.booking.count({ where: { vehicleId: id } }),
    db.monthlyAgreement.count({ where: { vehicleId: id } }),
  ]);
  if (bookings + monthly > 0)
    await db.vehicle.update({ where: { id }, data: { deletedAt: new Date() } });
  else await db.vehicle.delete({ where: { id } });

  const prefs = await getPreferences(userId);
  if (prefs.defaultVehicleId === id)
    await db.user.update({
      where: { id: userId },
      data: { preferences: { ...prefs, defaultVehicleId: null } },
    });
}

// ── Account deletion ──

/** Records the request; repeat requests keep the first timestamp. */
export async function requestDeletion(userId: string, reason?: string) {
  // ponytail: erasure/anonymisation is a manual ops process (admin reviews AuditLog
  // `user.deletion_requested`); automate it as a job once retention rules are settled.
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { deletionRequestedAt: true },
  });
  const at = user.deletionRequestedAt ?? new Date();
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { deletionRequestedAt: at } }),
    audit(userId, "user.deletion_requested", "User", userId, reason ?? null),
  ]);
  return { deletionRequestedAt: at.toISOString() };
}
