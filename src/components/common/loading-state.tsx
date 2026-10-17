import { Skeleton } from "@/components/ui/skeleton";

export function LoadingState({ label = "Loading content" }: { label?: string }) {
  return (
    <div className="space-y-4" role="status" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
