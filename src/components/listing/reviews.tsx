"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import type { ListListingReviewsResponse, ListingReviewItem } from "@/contracts/reviews";
import { api } from "@/lib/api-client";
import { formatIST } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface ReviewsProps {
  listingId: string;
}

export function Reviews({ listingId }: ReviewsProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ListingReviewItem[]>([]);
  const [summary, setSummary] = useState<{ average: number | null; count: number }>({
    average: null,
    count: 0,
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let live = true;
    api<ListListingReviewsResponse>(`/api/listings/${listingId}/reviews`).then(
      (res) => {
        if (!live) return;
        setReviews(res.items);
        setSummary(res.rating ?? res.summary ?? { average: null, count: 0 });
        setNextCursor(res.nextCursor);
        setError(null);
        setLoading(false);
      },
      (err: Error) => {
        if (!live) return;
        setError(err.message || "Failed to load reviews");
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [listingId, retryKey]);

  const handleRetry = () => {
    setLoading(true);
    setError(null);
    setRetryKey((k) => k + 1);
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await api<ListListingReviewsResponse>(
        `/api/listings/${listingId}/reviews?cursor=${encodeURIComponent(nextCursor)}`,
      );
      setReviews((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "Failed to load more reviews");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section aria-labelledby="reviews-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
        <h2 id="reviews-heading" className="text-xl font-semibold">
          Reviews
        </h2>
        {!loading && !error && summary.count > 0 && (
          <div className="flex items-center gap-1.5 text-sm">
            <Star aria-hidden="true" className="size-4 fill-amber-400 text-amber-400" />
            <span className="font-semibold">
              {summary.average !== null ? summary.average.toFixed(1) : "-"}
            </span>
            <span className="text-muted-foreground">
              ({summary.count} {summary.count === 1 ? "review" : "reviews"})
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div role="status" className="space-y-3">
          <span className="sr-only">Loading reviews</span>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : error ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={handleRetry}>
            Try again
          </Button>
        </div>
      ) : summary.count === 0 || reviews.length === 0 ? (
        <p className="text-muted-foreground text-sm">No reviews yet</p>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y space-y-4" aria-label="Customer reviews">
            {reviews.map((rev) => (
              <li key={rev.id} className="pt-4 first:pt-0 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">
                    {rev.reviewerFirstName ?? "Verified Renter"}
                  </span>
                  <time dateTime={rev.createdAt} className="text-xs text-muted-foreground">
                    {formatIST(new Date(rev.createdAt), "d MMM yyyy")}
                  </time>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center gap-0.5" aria-hidden="true">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className={`size-3.5 ${
                          star <= rev.rating
                            ? "fill-amber-400 text-amber-400"
                            : "text-muted-foreground/30"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {rev.rating} out of 5
                  </span>
                </div>
                {rev.comment ? (
                  <p className="text-sm text-foreground whitespace-pre-line">
                    {rev.comment}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {nextCursor && (
            <div className="pt-2 flex flex-col items-center gap-2">
              {moreError && (
                <p role="alert" className="text-xs text-destructive">
                  {moreError}
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading..." : "Show more"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
