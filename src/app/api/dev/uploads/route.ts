import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDemoMode } from "@/lib/demo";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

export function sniffImageFormat(buffer: Buffer): "jpg" | "png" | "webp" | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }

  return null;
}

export async function POST(req: Request) {
  if (!isDemoMode()) {
    return new Response("Not Found", { status: 404 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json(
      { error: { code: "validation_error", message: "Invalid multipart form data" } },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return Response.json(
      { error: { code: "validation_error", message: "File is required" } },
      { status: 400 },
    );
  }

  const blob = file as Blob;
  if (blob.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: { code: "validation_error", message: "File exceeds 8 MB limit" } },
      { status: 400 },
    );
  }

  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const format = sniffImageFormat(buffer);
  if (!format) {
    return Response.json(
      {
        error: {
          code: "validation_error",
          message: "Invalid image format. Only JPEG, PNG, and WebP are allowed.",
        },
      },
      { status: 400 },
    );
  }

  let publicId = String(formData.get("public_id") || "");
  let folder = String(formData.get("folder") || "");

  if (!publicId) {
    const randomName = randomUUID();
    folder = folder || "general";
    publicId = `${folder}/${randomName}`;
  }

  // Ensure publicId doesn't have directory traversal
  const sanitizedPublicId = publicId.replace(/\.\./g, "").replace(/^\/+/, "");
  const targetPath = path.join(process.cwd(), "public", "uploads", sanitizedPublicId);
  const targetDir = path.dirname(targetPath);

  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, buffer);

  const base = process.env.AUTH_URL || "";
  const relativeUrl = `/uploads/${sanitizedPublicId}`;
  const fullUrl = base ? `${base}${relativeUrl}` : relativeUrl;

  return Response.json({
    public_id: sanitizedPublicId,
    secure_url: fullUrl,
    url: fullUrl,
    format,
    bytes: buffer.length,
  });
}
