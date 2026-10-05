import { z } from "zod";
import { HostVerificationStatus, UserRole, VehicleType } from "../generated/prisma/enums";
import { IsoDateTime, Uuid } from "./common";

// FR-01. Everything here acts on the signed-in user; roles and verification status
// are never client-writable.

export const Profile = z.object({
  id: Uuid,
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  image: z.url().nullable(),
  roles: z.array(z.enum(UserRole)),
  hostVerificationStatus: z.enum(HostVerificationStatus),
  deletionRequestedAt: IsoDateTime.nullable(),
});
export type Profile = z.infer<typeof Profile>;

/** PATCH /api/me/profile. A changed phone must be re-verified. */
export const UpdateProfileBody = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "E.164 format, e.g. +919812345678")
    .nullable()
    .optional(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

// ── Vehicles ──

export const Vehicle = z.object({
  id: Uuid,
  registration: z.string(),
  type: z.enum(VehicleType),
  nickname: z.string().nullable(),
  heightCm: z.number().int().positive().nullable(),
  widthCm: z.number().int().positive().nullable(),
  lengthCm: z.number().int().positive().nullable(),
});
export type Vehicle = z.infer<typeof Vehicle>;

const vehicleInputFields = {
  /** Indian registration, stored uppercase without spaces, e.g. MH12AB1234. */
  registration: z
    .string()
    .trim()
    .transform((s) => s.replace(/[\s-]/g, "").toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{6,12}$/)),
  type: z.enum(VehicleType),
  nickname: z.string().trim().max(50).nullable().optional(),
  heightCm: z.number().int().positive().max(1000).nullable().optional(),
  widthCm: z.number().int().positive().max(1000).nullable().optional(),
  lengthCm: z.number().int().positive().max(2000).nullable().optional(),
};

/** GET /api/me/vehicles */
export const ListVehiclesResponse = z.object({ items: z.array(Vehicle) });
export type ListVehiclesResponse = z.infer<typeof ListVehiclesResponse>;

/** POST /api/me/vehicles */
export const CreateVehicleBody = z.strictObject(vehicleInputFields);
export type CreateVehicleBody = z.infer<typeof CreateVehicleBody>;

/** PATCH /api/me/vehicles/:id */
export const UpdateVehicleBody = z.strictObject(vehicleInputFields).partial();
export type UpdateVehicleBody = z.infer<typeof UpdateVehicleBody>;

/** DELETE /api/me/vehicles/:id */
export const DeleteVehicleResponse = z.object({ deleted: z.literal(true) });
export type DeleteVehicleResponse = z.infer<typeof DeleteVehicleResponse>;

// ── Preferences and notification settings ──

export const NotificationSettings = z.object({
  email: z.boolean(),
  inApp: z.boolean(),
  /** Session-ending reminders (FR-07); offsets come from policy. */
  sessionReminders: z.boolean(),
  marketing: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const Preferences = z.object({
  defaultVehicleId: Uuid.nullable(),
  notifications: NotificationSettings,
});
export type Preferences = z.infer<typeof Preferences>;

/** PATCH /api/me/preferences */
export const UpdatePreferencesBody = z.strictObject({
  defaultVehicleId: Uuid.nullable().optional(),
  notifications: z.strictObject(NotificationSettings.shape).partial().optional(),
});
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;

/** POST /api/me/deletion-request. Records the request; deletion itself is an admin/ops process. */
export const DeletionRequestBody = z
  .strictObject({
    reason: z.string().trim().max(1000).optional(),
  })
  .default({});
export type DeletionRequestBody = z.infer<typeof DeletionRequestBody>;
export const DeletionRequestResponse = z.object({ deletionRequestedAt: IsoDateTime });
export type DeletionRequestResponse = z.infer<typeof DeletionRequestResponse>;
