"use client";
import { ErrorState } from "@/components/common/error-state";
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState message="Please try again in a moment." onRetry={reset} />;
}
