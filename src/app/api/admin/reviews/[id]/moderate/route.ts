import { AdminModerateReviewBody, IdParams } from "@/contracts";
import { route } from "@/server/http/route";
import { moderateReview } from "@/server/reviews/service";

// POST /api/admin/reviews/:id/moderate
export const POST = route(
  { auth: "admin", params: IdParams, body: AdminModerateReviewBody },
  async ({ user, params, body }) => {
    const res = await moderateReview(user, params.id, body.decision, body.reason);
    return Response.json(res);
  },
);
