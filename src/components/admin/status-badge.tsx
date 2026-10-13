import { Badge } from "@/components/ui/badge";

type StatusBadgeProps = {
  status: string | null | undefined;
  className?: string;
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  if (!status) return <span className="text-muted-foreground text-xs">—</span>;

  const s = status.toUpperCase();
  let variant: "default" | "secondary" | "destructive" | "outline" = "outline";
  let customClasses = "";

  if (["VERIFIED", "PUBLISHED", "COMPLETED", "PAID", "RESOLVED", "APPROVED", "SUCCESS"].includes(s)) {
    variant = "default";
    customClasses = "bg-emerald-800 hover:bg-emerald-900 text-white";
  } else if (["PENDING", "UNDER_REVIEW", "DRAFT", "HOLD", "EXTENDED", "ORDER_CREATED"].includes(s)) {
    variant = "secondary";
    customClasses = "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950 dark:text-amber-200";
  } else if (["REJECTED", "SUSPENDED", "CANCELLED", "FAILED", "DEAD", "DISPUTED", "DISMISSED"].includes(s)) {
    variant = "destructive";
  }

  return (
    <Badge variant={variant} className={`font-mono text-xs uppercase tracking-wider ${customClasses} ${className ?? ""}`}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
