"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { toast } from "sonner";
import { type Profile, UpdateProfileBody } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
        {phone && (
          <p className="text-sm text-amber-700 dark:text-amber-400" role="note">
            Phone verification pending. We&apos;ll ask you to confirm this number with a code.
          </p>
        )}
        <Button type="submit" className="h-11" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save profile"}
        </Button>
      </form>
    </Section>
  );
}
