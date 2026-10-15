import { CreateReviewBody } from "@/contracts";
import { route } from "@/server/http/route";
import { createReview } from "@/server/reviews/service";

// POST /api/reviews (renter)
export const POST = route(
  {
    auth: "user",
    body: CreateReviewBody,
    rateLimit: { name: "reviews.create", limit: 30, windowSeconds: 3600 },
  },
  async ({ user, body }) => {
    const res = await createReview(user, body);
    return Response.json(res, { status: 201 });
  },
);
