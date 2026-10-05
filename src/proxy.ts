import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/guards";

// UX only: route handlers and pages still enforce auth server-side.
export async function proxy(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    const url = new URL("/sign-in", req.url);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  if (req.nextUrl.pathname.startsWith("/admin") && !user.roles.includes("ADMIN"))
    return NextResponse.redirect(new URL("/", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/host/:path*", "/bookings/:path*", "/account/:path*", "/admin/:path*"],
};
