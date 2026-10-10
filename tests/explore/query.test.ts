import { describe, expect, it } from "vitest";
import { apiQuery, bboxFromBounds, filterCount, withArea } from "@/components/explore/query";
import { findLocality } from "@/components/explore/localities";

describe("bboxFromBounds (Search this area)", () => {
  it("rounds outward so pins on the viewport edge stay inside", () => {
    expect(
      bboxFromBounds({ west: 73.81234, south: 18.50009, east: 73.91231, north: 18.56001 }),
    ).toEqual({
      minLat: 18.5,
      minLng: 73.8123,
      maxLat: 18.5601,
      maxLng: 73.9124,
    });
  });

  it("clamps a zoomed-out viewport to valid coordinates", () => {
    expect(bboxFromBounds({ west: -200, south: -95, east: 200, north: 95 })).toEqual({
      minLat: -90,
      minLng: -180,
      maxLat: 90,
      maxLng: 180,
    });
  });
});

describe("explore URL", () => {
  it("replaces the area, keeps filters, and drops the label from the API query", () => {
    const start = new URLSearchParams("q=Baner&lat=1&lng=2&radiusMeters=3000&covered=true");
    const next = withArea(start, { q: "Map area", minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 });
    expect(next.toString()).toBe("covered=true&q=Map+area&minLat=1&minLng=2&maxLat=3&maxLng=4");
    expect(apiQuery(next, "abc")).toBe(
      "covered=true&minLat=1&minLng=2&maxLat=3&maxLng=4&limit=20&cursor=abc",
    );
  });

  it("counts the time window once and each amenity", () => {
    expect(
      filterCount(new URLSearchParams("startAt=a&endAt=b&covered=true&amenities=lit,security")),
    ).toBe(4);
  });

  it("matches built-in localities case-insensitively", () => {
    expect(findLocality("koregaon park")?.lat).toBe(18.5362);
    expect(findLocality("magar")?.name).toBe("Magarpatta");
    expect(findLocality("nowhere")).toBeNull();
  });
});
