// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { VerificationBadge } from "@/components/listing/listing-detail";

describe("FR-11: VerificationBadge", () => {
  it("verification badge names what was checked and implies no guarantees", () => {
    const { container } = render(
      <VerificationBadge verified={true} hostName="Anjali Deshpande" />,
    );

    const badgeText = container.textContent ?? "";

    // Asserts the badge names the verified host
    expect(badgeText).toContain("Verified host: Anjali Deshpande");

    // Asserts the badge explicitly states what was checked: host identity and contact details
    expect(badgeText).toContain(
      "ParkShare reviewed this host's identity and contact details",
    );

    // Asserts the host authority declaration
    expect(badgeText).toContain(
      "The host declared they have the right to rent this space",
    );

    // Asserts the explicit limitation (space was not inspected)
    expect(badgeText).toContain("ParkShare has not inspected the space itself");

    // Asserts the badge contains no prohibited guarantee words (guaranteed, safe, trusted)
    expect(badgeText.toLowerCase()).not.toMatch(/\bguaranteed\b/);
    expect(badgeText.toLowerCase()).not.toMatch(/\bsafe\b/);
    expect(badgeText.toLowerCase()).not.toMatch(/\btrusted\b/);
  });

  it("verification badge formats correctly without a host name", () => {
    const { container } = render(
      <VerificationBadge verified={true} hostName={null} />,
    );

    const badgeText = container.textContent ?? "";

    expect(badgeText).toContain("Verified host.");
    expect(badgeText).toContain(
      "ParkShare reviewed this host's identity and contact details",
    );
    expect(badgeText.toLowerCase()).not.toMatch(/\bguaranteed\b/);
    expect(badgeText.toLowerCase()).not.toMatch(/\bsafe\b/);
    expect(badgeText.toLowerCase()).not.toMatch(/\btrusted\b/);
  });

  it("verification badge indicates pending or incomplete verification", () => {
    const { container } = render(
      <VerificationBadge verified={false} hostName="Rohit Kulkarni" />,
    );

    const badgeText = container.textContent ?? "";

    expect(badgeText).toContain(
      "This host's verification has not been completed yet.",
    );
    expect(badgeText.toLowerCase()).not.toMatch(/\bguaranteed\b/);
    expect(badgeText.toLowerCase()).not.toMatch(/\bsafe\b/);
    expect(badgeText.toLowerCase()).not.toMatch(/\btrusted\b/);
  });
});
