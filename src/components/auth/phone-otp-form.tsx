"use client";

import { useId, useState } from "react";
import type { PhoneOtpRequestResponse, PhoneOtpVerifyResponse } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api-client";

function message(e: unknown, fallback: string) {
  if (!(e instanceof ApiError)) return fallback;
  if (e.status === 429) return "Too many attempts. Wait a few minutes, then request a new code.";
  if (e.status === 503) return "Phone sign-in isn't available yet. Use email instead.";
  if (e.code === "conflict") return "This number is already verified on another account.";
  return e.issues[0]?.message ?? e.message ?? fallback;
}

/**
 * Two steps: send a one-time code to an Indian mobile, then enter it. Used signed out (sign-in)
 * and signed in (verifying the number on the profile). The server decides which by the session.
 */
export function PhoneOtpForm({
  initialPhone = "",
  lockPhone = false,
  submitLabel = "Text me a code",
  onVerified,
}: {
  initialPhone?: string;
  lockPhone?: boolean;
  submitLabel?: string;
  onVerified: (result: PhoneOtpVerifyResponse, phone: string) => void;
}) {
  const uid = useId();
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = `${uid}-error`;

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<PhoneOtpRequestResponse>("/api/auth/phone/request", "POST", { phone });
      setStep("code");
      setCode("");
    } catch (err) {
      setError(message(err, "Couldn't send a code. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<PhoneOtpVerifyResponse>("/api/auth/phone/verify", "POST", {
        phone,
        code,
      });
      onVerified(result, phone);
    } catch (err) {
      setError(message(err, "Couldn't check that code. Try again."));
      setBusy(false);
    }
  }

  const errorText = error && (
    <p id={errorId} role="alert" className="text-destructive text-sm">
      {error}
    </p>
  );

  if (step === "phone")
    return (
      <form onSubmit={send} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor={`${uid}-phone`}>{lockPhone ? "Number to verify" : "Mobile number"}</Label>
          <Input
            id={`${uid}-phone`}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+91 98123 45678"
            required
            readOnly={lockPhone}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={lockPhone ? "bg-muted h-11" : "h-11"}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        {errorText}
        <Button type="submit" variant="outline" className="h-11 w-full" disabled={busy}>
          {busy ? "Sending…" : submitLabel}
        </Button>
      </form>
    );

  return (
    <form onSubmit={verify} className="space-y-4" noValidate>
      <p role="status" className="text-muted-foreground text-sm">
        We texted a 6-digit code to {phone}. It expires in 10 minutes.
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${uid}-code`}>Code</Label>
        <Input
          id={`${uid}-code`}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className="h-11 tracking-widest"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {errorText}
      <Button type="submit" className="h-11 w-full" disabled={busy || code.length !== 6}>
        {busy ? "Checking…" : "Verify code"}
      </Button>
      <div className="flex justify-between text-sm">
        <button
          type="button"
          className="text-muted-foreground underline underline-offset-4"
          onClick={() => {
            setStep("phone");
            setError(null);
          }}
        >
          {lockPhone ? "Back" : "Change number"}
        </button>
        <button
          type="button"
          className="text-muted-foreground underline underline-offset-4"
          onClick={() => send()}
          disabled={busy}
        >
          Resend code
        </button>
      </div>
    </form>
  );
}
