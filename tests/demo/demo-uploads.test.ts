import { describe, expect, it, vi, afterEach } from "vitest";
import { sniffImageFormat } from "@/app/api/dev/uploads/route";
import { isOurUploadUrl, isOurEvidenceUrl, isOurReportEvidenceUrl } from "@/server/media/evidence";
import { photoUrl, signFolderUpload } from "@/server/listings/cloudinary";

describe("demo photo uploads and validators", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("magic-byte sniffing", () => {
    it("recognizes valid JPEG magic bytes (FF D8 FF)", () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      expect(sniffImageFormat(jpeg)).toBe("jpg");
    });

    it("recognizes valid PNG magic bytes", () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      expect(sniffImageFormat(png)).toBe("png");
    });

    it("recognizes valid WebP magic bytes (RIFF....WEBP)", () => {
      const webp = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x24, 0x00, 0x00, 0x00, // size
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      expect(sniffImageFormat(webp)).toBe("webp");
    });

    it("rejects non-image files and unknown formats", () => {
      const text = Buffer.from("Hello world, this is a plain text file.");
      expect(sniffImageFormat(text)).toBeNull();

      const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
      expect(sniffImageFormat(exe)).toBeNull();

      const short = Buffer.from([0xff, 0xd8]);
      expect(sniffImageFormat(short)).toBeNull();
    });
  });

  describe("local upload target in demo mode", () => {
    it("returns null when Cloudinary keys absent and demo mode is off", () => {
      vi.stubEnv("DEMO_MODE", "0");
      vi.stubEnv("CLOUDINARY_CLOUD_NAME", "");
      expect(signFolderUpload("listings/123")).toBeNull();
      expect(photoUrl("listings/123/p1")).toBeNull();
    });

    it("returns local upload target when demo mode is on and Cloudinary absent", () => {
      vi.stubEnv("DEMO_MODE", "1");
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("CLOUDINARY_CLOUD_NAME", "");
      const res = signFolderUpload("listings/123");
      expect(res).not.toBeNull();
      expect(res?.uploadUrl).toBe("/api/dev/uploads");
      expect(res?.publicId).toMatch(/^listings\/123\//);

      const url = photoUrl("listings/123/p1");
      expect(url).toContain("/uploads/listings/123/p1");
    });
  });

  describe("evidence and photo URL validation", () => {
    const listingId = "123e4567-e89b-12d3-a456-426614174000";
    const bookingId = "223e4567-e89b-12d3-a456-426614174001";
    const demoPhoto = `/uploads/listings/${listingId}/photo1.jpg`;
    const demoEvidence = `/uploads/incidents/${bookingId}/evidence1.png`;

    it("rejects /uploads/... URLs when demo mode is off", () => {
      vi.stubEnv("DEMO_MODE", "0");
      vi.stubEnv("NODE_ENV", "development");

      expect(isOurUploadUrl(demoPhoto, `listings/${listingId}`)).toBe(false);
      expect(isOurEvidenceUrl(demoEvidence, bookingId)).toBe(false);
      expect(isOurReportEvidenceUrl(demoPhoto)).toBe(false);
      expect(isOurReportEvidenceUrl(demoEvidence)).toBe(false);
    });

    it("accepts /uploads/... URLs when demo mode is on", () => {
      vi.stubEnv("DEMO_MODE", "1");
      vi.stubEnv("NODE_ENV", "development");

      expect(isOurUploadUrl(demoPhoto, `listings/${listingId}`)).toBe(true);
      expect(isOurEvidenceUrl(demoEvidence, bookingId)).toBe(true);
      expect(isOurReportEvidenceUrl(demoPhoto)).toBe(true);
      expect(isOurReportEvidenceUrl(demoEvidence)).toBe(true);
    });
  });
});
