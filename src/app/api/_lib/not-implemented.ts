/** Placeholder response for T2.0 route stubs; the implementing task replaces the handler. */
export function notImplemented() {
  return Response.json(
    { error: { code: "not_implemented", message: "Not implemented" } },
    { status: 501 },
  );
}
