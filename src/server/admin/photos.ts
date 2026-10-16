import type {
  AdminActionResponse,
  AdminListPhotosQuery,
  AdminListPhotosResponse,
  AdminModeratePhotoBody,
} from "@/contracts";
import { Uuid } from "@/contracts";
import type { Prisma } from "@/generated/prisma/client";
import type { CurrentUser } from "@/server/auth/guards";
import { db } from "@/server/db";
import { HttpError } from "@/server/http/errors";

export async function adminListPhotos(
  query: AdminListPhotosQuery,
): Promise<AdminListPhotosResponse> {
  if (query.cursor && !Uuid.safeParse(query.cursor).success)
    throw new HttpError("validation_error", "Invalid cursor");

  const limit = query.limit;
  const where: Prisma.ListingPhotoWhereInput = {
    ...(query.status ? { moderationStatus: query.status } : {}),
    ...(query.listingId ? { listingId: query.listingId } : {}),
  };

  const rows = await db.listingPhoto.findMany({
    where,
    include: {
      listing: { select: { title: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, limit);
  return {
    items: page.map((p) => ({
      id: p.id,
      listingId: p.listingId,
      listingTitle: p.listing.title,
      url: p.url,
      publicId: p.publicId,
      position: p.position,
      moderationStatus: p.moderationStatus,
      createdAt: p.createdAt.toISOString(),
    })),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}

export async function adminModeratePhoto(
  admin: CurrentUser,
  photoId: string,
  body: AdminModeratePhotoBody,
): Promise<AdminActionResponse> {
  if (!Uuid.safeParse(photoId).success)
    throw new HttpError("validation_error", "Invalid photo id");

  const photo = await db.listingPhoto.findUnique({
    where: { id: photoId },
    include: { listing: { select: { hostId: true, title: true } } },
  });
  if (!photo) throw new HttpError("not_found", "Photo not found");

  const audit = await db.$transaction(async (tx) => {
    await tx.listingPhoto.update({
      where: { id: photoId },
      data: { moderationStatus: body.decision },
    });
    return await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "photo.moderate",
        targetType: "ListingPhoto",
        targetId: photoId,
        reason: body.reason,
        metadata: {
          listingId: photo.listingId,
          decision: body.decision,
          previousStatus: photo.moderationStatus,
        },
      },
    });
  });

  return { ok: true, auditLogId: audit.id };
}
