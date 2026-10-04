import type { LucideIcon } from "lucide-react";

type EmptyStateProps = { icon?: LucideIcon; title: string; body: string; action?: React.ReactNode };

export function EmptyState({ icon: Icon, title, body, action }: EmptyStateProps) {
  return (
    <section
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center"
      aria-labelledby="empty-state-title"
    >
      {Icon ? <Icon aria-hidden="true" className="text-primary size-10" /> : null}
      <h2 id="empty-state-title" className="text-xl font-semibold">
        {title}
      </h2>
      <p className="text-muted-foreground">{body}</p>
      {action}
    </section>
  );
}
