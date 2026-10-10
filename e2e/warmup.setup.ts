import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test as setup } from "@playwright/test";
import { signIn } from "./helpers/session";

// `next dev` compiles each route on its first request. With every spec file hitting cold
// routes at once, a first compile can exceed the 5 s expect timeout (a click whose request is
// still compiling looks like a broken button). Compile every route once, before the specs run.

const ZERO = "00000000-0000-4000-8000-000000000000";

/** App Router URLs for every page.tsx / route.ts, dynamic segments filled with a dummy value. */
function routes(dir = "src/app", url = ""): { url: string; api: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isFile() && (e.name === "page.tsx" || e.name === "route.ts"))
      return [{ url: url || "/", api: e.name === "route.ts" }];
    if (!e.isDirectory()) return [];
    const seg = /^\(.*\)$/.test(e.name)
      ? ""
      : e.name.startsWith("[...")
        ? "/session"
        : e.name.startsWith("[")
          ? `/${ZERO}`
          : `/${e.name}`;
    return routes(join(dir, e.name), url + seg);
  });
}

setup("compile every route", async ({ page, context, baseURL }) => {
  setup.setTimeout(300_000); // the warm-up itself; spec timeouts are unchanged
  await signIn(context, baseURL!); // protected pages redirect (uncompiled) without a session
  const all = routes();
  // A GET is enough to compile a route, even one that only exports POST (405).
  await Promise.all(all.filter((r) => r.api).map((r) => context.request.get(r.url)));
  // Pages through the browser, so their client chunks compile too.
  for (const r of all.filter((r) => !r.api)) await page.goto(r.url);
});
