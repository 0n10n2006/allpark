"use client";

import { Button } from "@/components/ui/button";

export function ErrorState({
  message = "Something went wrong.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <section role="alert" className="border-destructive/30 bg-destructive/10 rounded-xl border p-6">
      <h2 className="font-semibold">Unable to load this page</h2>
      <p className="mt-1 text-sm">{message}</p>
      {onRetry ? (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </section>
  );
}
