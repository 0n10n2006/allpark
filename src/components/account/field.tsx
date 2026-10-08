import type { ReactNode } from "react";
import type { FieldError, FieldValues, Path, UseFormSetError } from "react-hook-form";
import { Label } from "@/components/ui/label";
import { ApiError, fieldErrors } from "@/lib/api-client";

type ControlProps = {
  id: string;
  "aria-invalid"?: true;
  "aria-describedby"?: string;
};

/** The shadcn destructive variant's tinted red fails 4.5:1 contrast; use a solid fill. */
export const DANGER = "h-11 bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive";

/** A titled account section; the h2 names the region for screen readers. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section
      aria-labelledby={id}
      className="bg-card ring-foreground/10 rounded-xl p-4 ring-1 sm:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-xl font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label + control + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: FieldError;
  children: (props: ControlProps) => ReactNode;
}) {
  const describedBy =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-destructive text-sm">
          {error.message}
        </p>
      )}
    </div>
  );
}

/**
 * Puts a server error next to the matching field (focusing the first one).
 * Returns false when nothing could be attached, so the caller can toast instead.
 */
export function applyServerErrors<T extends FieldValues>(
  e: unknown,
  fields: readonly Path<T>[],
  setError: UseFormSetError<T>,
  conflictField?: Path<T>,
): boolean {
  if (!(e instanceof ApiError)) return false;
  const matched = fieldErrors(e).filter((f) => fields.includes(f.field as Path<T>));
  const errors =
    matched.length > 0
      ? matched.map((f) => ({
          field: f.field as Path<T>,
          message: e.code === "validation_error" ? f.message : `${e.message} (${f.message})`,
        }))
      : e.code === "conflict" && conflictField
        ? [{ field: conflictField, message: e.message }]
        : [];
  errors.forEach((f, i) => setError(f.field, { message: f.message }, { shouldFocus: i === 0 }));
  return errors.length > 0;
}
