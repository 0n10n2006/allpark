import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Flag,
  UserCheck,
  IndianRupee,
  Flame,
  BellOff,
  ArrowRight,
  Shield,
  FileCheck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/common/loading-state";
import { requireRole } from "@/server/auth/guards";
import { adminGetStats } from "@/server/admin/service";

export default function AdminDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Operations Dashboard</h2>
        <p className="text-muted-foreground text-sm">
          Real-time queue health and action items requiring administrative attention.
        </p>
      </div>

      <Suspense fallback={<LoadingState label="Loading dashboard metrics..." />}>
        <DashboardStats />
      </Suspense>

      <section aria-labelledby="compliance-notice-heading" className="rounded-xl border bg-muted/40 p-5">
        <div className="flex items-start gap-3">
          <Shield className="text-primary mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            <h3 id="compliance-notice-heading" className="text-sm font-semibold">
              Administrative Compliance (FR-11 & FR-13)
            </h3>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Every mutating operation in this console requires a documented, substantive reason. All
              actions, decisions, targets, and actor IDs are durably appended to the immutable AuditLog.
              Host verification confirms submitted document identity only and carries no implied
              safety, quality, or reliability guarantee.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

async function DashboardStats() {
  await requireRole("ADMIN");
  const stats = await adminGetStats();

  const statCards = [
    {
      title: "Open Disputes",
      count: stats.openDisputesCount,
      description: "Disputes awaiting review or resolution",
      href: "/admin/disputes",
      icon: AlertTriangle,
      color: stats.openDisputesCount > 0 ? "text-amber-600" : "text-muted-foreground",
      badgeColor: stats.openDisputesCount > 0 ? "bg-amber-100 text-amber-900" : "bg-muted text-muted-foreground",
    },
    {
      title: "Open Reports",
      count: stats.openReportsCount,
      description: "User or listing reports flagged for moderation",
      href: "/admin/reports",
      icon: Flag,
      color: stats.openReportsCount > 0 ? "text-red-600" : "text-muted-foreground",
      badgeColor: stats.openReportsCount > 0 ? "bg-red-100 text-red-900" : "bg-muted text-muted-foreground",
    },
    {
      title: "Pending Verifications",
      count: stats.pendingHostVerificationsCount,
      description: "Host identity verifications submitted",
      href: "/admin/users?hostVerificationStatus=PENDING",
      icon: UserCheck,
      color: stats.pendingHostVerificationsCount > 0 ? "text-blue-600" : "text-muted-foreground",
      badgeColor: stats.pendingHostVerificationsCount > 0 ? "bg-blue-100 text-blue-900" : "bg-muted text-muted-foreground",
    },
    {
      title: "Pending Payouts",
      count: stats.pendingPayoutsCount,
      description: "Host payouts awaiting bank transfer recording",
      href: "/admin/payouts",
      icon: IndianRupee,
      color: stats.pendingPayoutsCount > 0 ? "text-emerald-600" : "text-muted-foreground",
      badgeColor: stats.pendingPayoutsCount > 0 ? "bg-emerald-100 text-emerald-900" : "bg-muted text-muted-foreground",
    },
    {
      title: "Dead Jobs",
      count: stats.deadJobsCount,
      description: "Background jobs exhausted max retry attempts",
      href: "/admin/jobs",
      icon: Flame,
      color: stats.deadJobsCount > 0 ? "text-destructive" : "text-muted-foreground",
      badgeColor: stats.deadJobsCount > 0 ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
    },
    {
      title: "Failed Notifications",
      count: stats.failedNotificationsCount,
      description: "SMS, WhatsApp, or Push deliveries that failed",
      href: "/admin/jobs?tab=notifications",
      icon: BellOff,
      color: stats.failedNotificationsCount > 0 ? "text-amber-600" : "text-muted-foreground",
      badgeColor: stats.failedNotificationsCount > 0 ? "bg-amber-100 text-amber-900" : "bg-muted text-muted-foreground",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {statCards.map((card) => {
        const Icon = card.icon;
        return (
          <Link
            key={card.title}
            href={card.href}
            className="group block rounded-xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="h-full transition-all duration-200 hover:border-primary hover:shadow-md">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                <div className={`rounded-lg p-2 ${card.badgeColor}`}>
                  <Icon className="size-4" aria-hidden="true" />
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className={`text-3xl font-extrabold ${card.color}`}>{card.count}</div>
                <CardDescription className="text-xs">{card.description}</CardDescription>
                <div className="text-primary flex items-center pt-2 text-xs font-semibold group-hover:underline">
                  <span>Open queue</span>
                  <ArrowRight className="ml-1 size-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
