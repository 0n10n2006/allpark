"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ImageOff, ParkingSquare, Plus } from "lucide-react";
import type { HostStatusResponse, MyListingsResponse, OwnedListing } from "@/contracts";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { LoadingState } from "@/components/common/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { api, errorMessage } from "./api";
import { STATUS_LABELS, priceFrom } from "./labels";

type Status = HostStatusResponse["hostVerificationStatus"];
type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; host: HostStatusResponse; listings: OwnedListing[] };

export function HostDashboard() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const host = await api<HostStatusResponse>("/api/me");
      const listings = host.roles.includes("HOST")
        ? (await api<MyListingsResponse>("/api/listings/mine?limit=100")).items
        : [];
      setState({ kind: "ready", host, listings });
    } catch (e) {
      setState({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  if (state.kind === "loading") return <LoadingState label="Loading your host area" />;
  if (state.kind === "error")
    return (
      <ErrorState
        message={state.message}
        onRetry={() => {
          setState({ kind: "loading" });
          void load();
        }}
      />
    );
  if (!state.host.roles.includes("HOST")) return <Onboarding onDone={load} />;
  return (
    <div className="space-y-8">
      <StatusBanner status={state.host.hostVerificationStatus} onReapply={load} />
      <MyListings listings={state.listings} />
    </div>
  );
}

function useApply(onDone: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/host", "POST", { attestAuthority: true });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, apply };
}

function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [attested, setAttested] = useState(false);
  const { busy, error, apply } = useApply(onDone);
  return (
    <form
      className="bg-card max-w-2xl space-y-4 rounded-xl border p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (attested) void apply();
      }}
    >
      <h2 className="text-xl font-semibold">Become a host</h2>
      <p>
        Share your parking space and earn when you&apos;re not using it. Here&apos;s how it works:
      </p>
      <ol className="list-decimal space-y-1 pl-6">
        <li>Apply below. You can start drafting listings right away.</li>
        <li>
          A ParkShare admin reviews your host application. Until you&apos;re verified, your listings
          stay as drafts and can&apos;t be booked.
        </li>
        <li>Once verified, publish your listings so renters can book them.</li>
      </ol>
      <label className="flex min-h-11 items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-5 shrink-0"
          checked={attested}
          onChange={(e) => setAttested(e.target.checked)}
          aria-describedby="attest-help"
        />
        <span>
          I&apos;m authorized to rent out the spaces I list
          <span id="attest-help" className="text-muted-foreground block text-sm">
            You own the space, or the owner or society allows you to rent it out.
          </span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="min-h-11 px-4" disabled={!attested || busy}>
        {busy ? "Submitting…" : "Become a host"}
      </Button>
    </form>
  );
}

const BANNERS: Record<Status, { title: string; body: string; tone: string }> = {
  NOT_STARTED: {
    title: "Verification not started",
    body: "Submit your host application so a ParkShare admin can review it. You can draft listings meanwhile, but you can't publish them until you're verified.",
    tone: "border-amber-600/40 bg-amber-50 dark:bg-amber-950/30",
  },
  PENDING: {
    title: "Verification pending",
    body: "A ParkShare admin is reviewing your host application. You can create and edit drafts now; you'll be able to publish once you're verified.",
    tone: "border-amber-600/40 bg-amber-50 dark:bg-amber-950/30",
  },
  VERIFIED: {
    title: "Verified host",
    body: "A ParkShare admin reviewed and approved your host application, so you can publish listings. Verification covers your host account only; it isn't an inspection of your spaces.",
    tone: "border-emerald-600/40 bg-emerald-50 dark:bg-emerald-950/30",
  },
  REJECTED: {
    title: "Verification not approved",
    body: "Your host application wasn't approved, so you can't publish listings. Your drafts are kept. Check your account details and apply again.",
    tone: "border-destructive/40 bg-destructive/10",
  },
};

function StatusBanner({ status, onReapply }: { status: Status; onReapply: () => Promise<void> }) {
  const b = BANNERS[status];
  const { busy, error, apply } = useApply(onReapply);
  return (
    <section aria-labelledby="host-status" className={`rounded-xl border p-4 ${b.tone}`}>
      <h2 id="host-status" className="font-semibold">
        {b.title}
      </h2>
      <p className="mt-1 text-sm">{b.body}</p>
      {status === "NOT_STARTED" || status === "REJECTED" ? (
        <Button className="mt-3 min-h-11 px-4" onClick={() => void apply()} disabled={busy}>
          {busy ? "Submitting…" : "Apply for verification"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const newListing = (
  <Link href="/host/listings/new" className={buttonVariants({ className: "min-h-11 px-4" })}>
    <Plus aria-hidden="true" /> New listing
  </Link>
);

function MyListings({ listings }: { listings: OwnedListing[] }) {
  return (
    <section aria-labelledby="my-listings" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="my-listings" className="text-2xl font-semibold">
          My listings
        </h2>
        {listings.length ? newListing : null}
      </div>
      {listings.length === 0 ? (
        <EmptyState
          icon={ParkingSquare}
          title="No listings yet"
          body="Create your first listing. It's saved as a draft as you go."
          action={newListing}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ListingCard({ listing: l }: { listing: OwnedListing }) {
  const cover = l.photos[0]?.url;
  const price = priceFrom(l.prices);
  return (
    <li className="bg-card flex flex-col overflow-hidden rounded-xl border">
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element -- Cloudinary host isn't in next/image remotePatterns
        <img src={cover} alt="" className="aspect-video w-full object-cover" />
      ) : (
        <div className="bg-muted text-muted-foreground flex aspect-video items-center justify-center gap-2 text-sm">
          <ImageOff aria-hidden="true" className="size-5" /> No photo yet
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold break-words">{l.title}</h3>
          <Badge variant={l.status === "PUBLISHED" ? "default" : "secondary"}>
            {STATUS_LABELS[l.status]}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">{l.locality}</p>
        <p className="text-sm">{price ? `From ${price}` : "No price set"}</p>
        {l.status === "SUSPENDED" && l.suspendedReason ? (
          <p className="text-destructive text-sm">Suspended: {l.suspendedReason}</p>
        ) : null}
        <Link
          href={`/host/listings/${l.id}/edit`}
          className={buttonVariants({ variant: "outline", className: "mt-auto min-h-11" })}
        >
          Edit<span className="sr-only"> {l.title}</span>
        </Link>
      </div>
    </li>
  );
}
