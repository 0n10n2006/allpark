"use client";

import { PhoneOtpForm } from "./phone-otp-form";

/** Signed-out phone sign-in: the verify call sets the session cookie, then we leave the page. */
export function PhoneSignIn({ callbackUrl }: { callbackUrl: string }) {
  return (
    <PhoneOtpForm
      onVerified={() => {
        // Full navigation so server components and the proxy see the new session cookie.
        window.location.assign(callbackUrl);
      }}
    />
  );
}
