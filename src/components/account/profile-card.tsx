"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { toast } from "sonner";
import { type Profile, UpdateProfileBody } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneOtpForm } from "@/components/auth/phone-otp-form";
import { api } from "@/lib/api-client";
import { applyServerErrors, Field, Section } from "./field";

/** setValueAs also sees the (possibly null) default value, not just typed strings. */
const blankTo =
  <T,>(empty: T) =>
  (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : empty;

export function ProfileCard({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: (p: Profile) => void;
}) {
  const [phone, setPhone] = useState(profile.phone);
  const [verifying, setVerifying] = useState(false);
  const form = useForm<
    z.input<typeof UpdateProfileBody>,
    unknown,
    z.output<typeof UpdateProfileBody>
  >({
    resolver: zodResolver(UpdateProfileBody),
    defaultValues: { name: profile.name ?? undefined, phone: profile.phone },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(body: UpdateProfileBody) {
    try {
      const saved = await api<Profile>("/api/me/profile", { method: "PATCH", body });
      setPhone(saved.phone);
      setVerifying(false);
      onSaved(saved);
      toast.success("Profile saved");
    } catch (e) {
      if (!applyServerErrors(e, ["name", "phone"], form.setError, "phone"))
        toast.error("Couldn't save your profile. Try again.");
    }
  }

  return (
    <Section title="Profile">
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id="profile-name" label="Name" error={errors.name}>
          {(p) => (
            <Input
              {...p}
              {...form.register("name", { setValueAs: blankTo(undefined) })}
              autoComplete="name"
              className="h-11"
            />
          )}
        </Field>
        <Field id="profile-email" label="Email" hint="Your sign-in email can't be changed here.">
          {(p) => <Input {...p} value={profile.email ?? ""} readOnly className="bg-muted h-11" />}
        </Field>
        <Field
          id="profile-phone"
          label="Mobile number"
          hint="Indian mobile with +91, e.g. +919812345678"
          error={errors.phone}
        >
          {(p) => (
            <Input
              {...p}
              {...form.register("phone", { setValueAs: blankTo(null) })}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+91"
              className="h-11"
            />
          )}
        </Field>
        {phone && profile.phoneVerified && (
          <p className="text-sm text-green-700 dark:text-green-400" role="note">
            Number verified.
          </p>
        )}
        {phone && !profile.phoneVerified && !verifying && (
          <div className="flex flex-wrap items-center gap-3" role="note">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Not verified yet. Confirm this number with a one-time code.
            </p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setVerifying(true)}
            >
              Verify number
            </Button>
          </div>
        )}
        <Button type="submit" className="h-11" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save profile"}
        </Button>
      </form>
      {phone && !profile.phoneVerified && verifying && (
        <div className="mt-4 border-t pt-4">
          <PhoneOtpForm
            initialPhone={phone}
            lockPhone
            submitLabel="Text me a code"
            onVerified={() => {
              setVerifying(false);
              onSaved({ ...profile, phone, phoneVerified: true });
              toast.success("Number verified");
            }}
          />
        </div>
      )}
    </Section>
  );
}
