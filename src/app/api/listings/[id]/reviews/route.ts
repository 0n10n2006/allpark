import { IdParams, PaginationQuery } from "@/contracts";
import { route } from "@/server/http/route";
import { listListingReviews } from "@/server/reviews/service";

// GET /api/listings/:id/reviews (public; APPROVED only; paginated; reviewer first name only)
export const GET = route(
  { auth: "public", params: IdParams, query: PaginationQuery },
  async ({ params, query }) => {
    const res = await listListingReviews(params.id, query.limit, query.cursor);
    return Response.json(res);
  },
);
