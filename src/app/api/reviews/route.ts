import { CreateReviewBody } from "@/contracts";
import { route } from "@/server/http/route";
import { createReview } from "@/server/reviews/service";

// POST /api/reviews (renter)
export const POST = route({ auth: "user", body: CreateReviewBody }, async ({ user, body }) => {
  const res = await createReview(user, body);
  return Response.json(res, { status: 201 });
});
