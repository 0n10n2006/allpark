import { AdminListReviewsQuery } from "@/contracts";
import { adminListReviews } from "@/server/admin/service";
import { route } from "@/server/http/route";

// GET /api/admin/reviews: list reviews with moderationStatus filter (FR-13 / FR-11)
export const GET = route(
  { auth: "admin", query: AdminListReviewsQuery },
  async ({ user, query }) => {
    const res = await adminListReviews(user, query);
    return Response.json(res);
  },
);
