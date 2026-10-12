"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api-client";
import type { Review } from "@/contracts/reviews";

export interface ReviewFormProps {
  bookingId?: string;
  booking?: { id: string; listing?: { title: string } };
  listingTitle?: string;
  onSubmitted?: () => void;
}

export function ReviewForm({
  bookingId: directBookingId,
  booking,
  listingTitle,
  onSubmitted,
}: ReviewFormProps) {
  const router = useRouter();
  const id = useId();
  const targetBookingId = directBookingId ?? booking?.id;
  const targetListingTitle = listingTitle ?? booking?.listing?.title;

  const [rating, setRating] = useState<number>(5);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [submittedReview, setSubmittedReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!targetBookingId) return null;

  if (submittedReview) {
    return (
      <section
        aria-labelledby="review-success-title"
        className="mt-6 rounded-xl border bg-muted/30 p-6 text-center"
      >
        <h2 id="review-success-title" className="text-lg font-semibold text-foreground">
          Thank you for your review!
        </h2>
        <div className="mt-2 flex items-center justify-center gap-1" aria-label={`Rated ${submittedReview.rating} out of 5 stars`}>
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              className={`size-5 ${
                star <= submittedReview.rating
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground"
              }`}
            />
          ))}
        </div>
        {submittedReview.comment ? (
          <p className="mt-3 text-sm text-muted-foreground whitespace-pre-wrap">
            {submittedReview.comment}
          </p>
        ) : null}
      </section>
    );
  }

  const activeRating = hoverRating ?? rating;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating < 1 || rating > 5) {
      setError("Please select a rating between 1 and 5 stars");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const trimmedComment = comment.trim();
      const res = await api<Review>("/api/reviews", {
        method: "POST",
        body: {
          bookingId: targetBookingId,
          rating,
          comment: trimmedComment.length > 0 ? trimmedComment : undefined,
        },
      });

      setSubmittedReview(res);
      toast.success("Review submitted! Thank you for your feedback.");
      router.refresh();
      onSubmitted?.();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        toast.error(err.message);
      } else {
        setError("Failed to submit review. Please try again.");
        toast.error("Failed to submit review");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="review-form-title" className="mt-6 rounded-xl border p-6">
      <h2 id="review-form-title" className="text-lg font-semibold">
        Leave a review {targetListingTitle ? `for ${targetListingTitle}` : ""}
      </h2>
      <p className="text-sm text-muted-foreground mt-1">
        How was your parking experience? Your review helps other drivers.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 grid gap-4" noValidate>
        <div>
          <Label id={`${id}-rating-label`} className="text-sm font-medium">
            Rating
          </Label>
          <div
            role="radiogroup"
            aria-labelledby={`${id}-rating-label`}
            className="mt-2 flex items-center gap-1"
          >
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                role="radio"
                aria-checked={rating === star}
                aria-label={`${star} star${star === 1 ? "" : "s"}`}
                disabled={busy}
                onClick={() => setRating(star)}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(null)}
                className="rounded p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Star
                  className={`size-7 transition-colors ${
                    star <= activeRating
                      ? "fill-amber-400 text-amber-400"
                      : "text-muted-foreground/40 hover:text-muted-foreground"
                  }`}
                />
              </button>
            ))}
            <span className="ml-2 text-sm text-muted-foreground font-medium">
              {rating} of 5 stars
            </span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor={`${id}-comment`} className="text-sm font-medium">
              Comment (optional)
            </Label>
            <span className="text-xs text-muted-foreground">
              {comment.length} / 1000
            </span>
          </div>
          <Textarea
            id={`${id}-comment`}
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 1000))}
            placeholder="Share details of your experience with access, security, or cleanliness..."
            className="mt-2 min-h-24 resize-y"
            maxLength={1000}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
          />
        </div>

        {error ? (
          <p id={`${id}-err`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="h-11 w-full sm:w-auto">
          {busy ? "Submitting..." : "Submit review"}
        </Button>
      </form>
    </section>
  );
}
