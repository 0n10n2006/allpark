"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type {
  DeletionRequestResponse,
  ListVehiclesResponse,
  Preferences,
  Profile,
} from "@/contracts";
import { ErrorState } from "@/components/common/error-state";
import { LoadingState } from "@/components/common/loading-state";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api-client";
import { formatIST } from "@/lib/time";
import { DANGER, Section } from "./field";
import { PreferencesSection } from "./preferences-section";
import { ProfileCard } from "./profile-card";
import { VehiclesSection } from "./vehicles-section";

type Data = { profile: Profile; preferences: Preferences; vehicles: ListVehiclesResponse };

function DeletionRequest({
  requestedAt,
  onRequested,
}: {
  requestedAt: string | null;
  onRequested: (at: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await api<DeletionRequestResponse>("/api/me/deletion-request", {
        method: "POST",
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      onRequested(res.deletionRequestedAt);
      setOpen(false);
      toast.success("Deletion request sent to support");
    } catch {
      toast.error("Couldn't send your request. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Delete account">
      {requestedAt ? (
        <p role="status">
          You requested account deletion on {formatIST(new Date(requestedAt), "d MMM yyyy, h:mm a")}{" "}
          IST. Our support team is reviewing it and will email you.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground mb-4 text-sm">
            Ask us to delete your account and personal data. Support reviews every request.
          </p>
          <Button variant="destructive" className={DANGER} onClick={() => setOpen(true)}>
            Request account deletion
          </Button>
        </>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request account deletion?</DialogTitle>
            <DialogDescription>
              Your account isn&apos;t deleted straight away. Our support team reviews the request,
              settles any open bookings, payouts or disputes, and emails you when it&apos;s done.
              Some records are kept where the law requires it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="deletion-reason">Reason (optional)</Label>
            <Textarea
              id="deletion-reason"
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" className={DANGER} disabled={busy} onClick={submit}>
              {busy ? "Sending…" : "Send request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

export function AccountView() {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [profile, preferences, vehicles] = await Promise.all([
        api<Profile>("/api/me/profile"),
        api<Preferences>("/api/me/preferences"),
        api<ListVehiclesResponse>("/api/me/vehicles"),
      ]);
      setData({ profile, preferences, vehicles });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        router.replace("/sign-in?callbackUrl=%2Faccount");
      else setError("We couldn't load your account. Check your connection and try again.");
    }
  }, [router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading your account" />;

  const { profile } = data;
  const setProfile = (p: Profile) => setData((d) => d && { ...d, profile: p });

  return (
    <div className="space-y-6">
      <ProfileCard profile={profile} onSaved={setProfile} />
      <VehiclesSection
        initialVehicles={data.vehicles.items}
        initialDefaultId={data.preferences.defaultVehicleId}
      />
      <PreferencesSection initial={data.preferences.notifications} />
      <Section title="Hosting">
        <p className="text-muted-foreground mb-4 text-sm">
          {profile.roles.includes("HOST")
            ? "Manage your spaces, availability and payouts."
            : "Earn from your unused parking space."}
        </p>
        <Link href="/host" className={buttonVariants({ variant: "outline", className: "h-11" })}>
          {profile.roles.includes("HOST") ? "Go to hosting" : "Become a host"}
        </Link>
      </Section>
      <DeletionRequest
        requestedAt={profile.deletionRequestedAt}
        onRequested={(at) => setProfile({ ...profile, deletionRequestedAt: at })}
      />
      <Link
        href="/sign-out"
        className={buttonVariants({ variant: "outline", className: "h-11 w-full sm:w-auto" })}
      >
        Sign out
      </Link>
    </div>
  );
}
