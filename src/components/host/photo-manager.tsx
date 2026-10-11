"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Trash2, Upload } from "lucide-react";
import type { ListingPhoto, ListingPhotosResponse, SignPhotoUploadResponse } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, api, errorMessage } from "@/lib/api-client";

const TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Signs, uploads straight to Cloudinary with exactly the signed params, then attaches it. */
async function uploadOne(listingId: string, file: File): Promise<ListingPhoto> {
  const s = await api<SignPhotoUploadResponse>(
    `/api/listings/${listingId}/photos/sign`,
    "POST",
    {},
  );
  if (s.maxFileBytes && file.size > s.maxFileBytes)
    throw new Error(`${file.name} is larger than ${Math.round(s.maxFileBytes / 1048576)} MB.`);
  const form = new FormData();
  form.set("file", file);
  form.set("api_key", s.apiKey);
  form.set("timestamp", String(s.timestamp));
  form.set("signature", s.signature);
  form.set("public_id", s.publicId);
  if (s.allowedFormats) form.set("allowed_formats", s.allowedFormats);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${s.cloudName}/image/upload`, {
    method: "POST",
    body: form,
  }).catch(() => null);
  if (!res?.ok) throw new Error(`Uploading ${file.name} failed. Try again.`);
  return api<ListingPhoto>(`/api/listings/${listingId}/photos`, "POST", { publicId: s.publicId });
}

export function PhotoManager({
  listingId,
  photos,
  onChange,
}: {
  listingId: string;
  photos: ListingPhoto[];
  onChange: (p: ListingPhoto[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);
  const [announce, setAnnounce] = useState("");

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (e instanceof ApiError && e.code === "uploads_not_configured") setUnconfigured(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = (files: File[]) =>
    run(async () => {
      let list = photos;
      for (const file of files) {
        if (!TYPES.includes(file.type))
          throw new Error(`${file.name}: use a JPG, PNG or WebP image.`);
        list = [...list, await uploadOne(listingId, file)];
        onChange(list);
      }
      setAnnounce(`${files.length} photo${files.length === 1 ? "" : "s"} uploaded.`);
    });

  /** Keep keyboard focus on the photo the user just acted on (re-ordering blurs it). */
  const focusLater = (id: string) =>
    requestAnimationFrame(() => document.getElementById(id)?.focus());

  const move = (i: number, to: number) =>
    run(async () => {
      const ids = photos.map((p) => p.id);
      [ids[i], ids[to]] = [ids[to], ids[i]];
      const r = await api<ListingPhotosResponse>(`/api/listings/${listingId}/photos`, "PATCH", {
        photoIds: ids,
      });
      onChange(r.items);
      const moved = photos[i].id;
      const dir = to < i ? "up" : "down";
      const atEdge = dir === "up" ? to === 0 : to === r.items.length - 1;
      focusLater(`photo-${moved}-${atEdge ? (dir === "up" ? "down" : "up") : dir}`);
      setAnnounce(`Photo moved to position ${to + 1}${to === 0 ? ", now the cover photo" : ""}.`);
    });

  const remove = (id: string, i: number) =>
    run(async () => {
      const r = await api<ListingPhotosResponse>(
        `/api/listings/${listingId}/photos?photoId=${id}`,
        "DELETE",
      );
      onChange(r.items);
      const next = r.items[Math.min(i, r.items.length - 1)];
      focusLater(next ? `photo-${next.id}-delete` : "photo-upload");
      setAnnounce(`Photo ${i + 1} deleted.`);
    });

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Add at least one photo; two or more help renters find the spot. The first photo is the
        cover. JPG, PNG or WebP, up to 8 MB each.
      </p>
      {unconfigured ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-600/40 bg-amber-50 p-4 dark:bg-amber-950/30"
        >
          <p className="font-semibold">Photo uploads aren&apos;t configured in this environment</p>
          <p className="mt-1 text-sm">
            The image service keys are missing here, so photos can&apos;t be added. Your other
            changes still save. You&apos;ll need a photo before you can publish.
          </p>
        </div>
      ) : (
        <label
          className={`border-input hover:bg-muted has-[:focus-visible]:ring-ring/50 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-4 text-sm font-medium has-[:focus-visible]:ring-3 ${busy ? "pointer-events-none opacity-50" : ""}`}
        >
          <Upload aria-hidden="true" className="size-4" />
          {busy ? "Working…" : "Upload photos"}
          <input
            id="photo-upload"
            type="file"
            accept={TYPES.join(",")}
            multiple
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void upload(files);
            }}
          />
        </label>
      )}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {photos.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm">No photos yet.</p>
      ) : (
        <ol className="grid gap-4 sm:grid-cols-2" aria-label="Listing photos">
          {photos.map((p, i) => (
            <li key={p.id} className="overflow-hidden rounded-lg border">
              {/* eslint-disable-next-line @next/next/no-img-element -- Cloudinary host isn't in next/image remotePatterns */}
              <img
                src={p.url}
                alt={`Photo ${i + 1}`}
                className="aspect-video w-full object-cover"
              />
              <div className="flex flex-wrap items-center gap-2 p-2">
                <span className="text-sm">Photo {i + 1}</span>
                {i === 0 ? <Badge>Cover</Badge> : null}
                <span className="ml-auto flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    id={`photo-${p.id}-up`}
                    className="min-h-11 min-w-11"
                    focusableWhenDisabled
                    disabled={busy || i === 0}
                    onClick={() => void move(i, i - 1)}
                  >
                    <ArrowUp aria-hidden="true" />
                    <span className="sr-only">Move photo {i + 1} up</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    id={`photo-${p.id}-down`}
                    className="min-h-11 min-w-11"
                    focusableWhenDisabled
                    disabled={busy || i === photos.length - 1}
                    onClick={() => void move(i, i + 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                    <span className="sr-only">Move photo {i + 1} down</span>
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    id={`photo-${p.id}-delete`}
                    className="min-h-11 min-w-11"
                    focusableWhenDisabled
                    disabled={busy}
                    onClick={() => void remove(p.id, i)}
                  >
                    <Trash2 aria-hidden="true" />
                    <span className="sr-only">Delete photo {i + 1}</span>
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
