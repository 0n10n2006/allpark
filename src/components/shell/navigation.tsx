"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, House, UserRound, CalendarDays } from "lucide-react";
import { cn } from "cn";

const items = [
  { href: "/explore", label: "Explore", icon: Compass },
  { href: "/bookings", label: "Bookings", icon: CalendarDays },
  { href: "/host", label: "Host", icon: House },
  { href: "/account", label: "Account", icon: UserRound },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavigationLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return items.map(({ href, label, icon: Icon }) => {
    const active = isActive(pathname, href);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "focus-visible:ring-ring inline-flex items-center justify-center gap-2 rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
          mobile
            ? "min-h-11 min-w-11 flex-1 flex-col px-1 py-1 text-xs"
            : "min-h-11 px-3 text-sm",
          active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Icon aria-hidden="true" className="size-5" />
        <span>{label}</span>
      </Link>
    );
  });
}

export function SiteNavigation() {
  return (
    <>
      <header className="border-border hidden border-b md:block">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/explore" className="text-primary text-lg font-bold">ParkShare</Link>
          <nav aria-label="Primary navigation" className="flex items-center gap-1"><NavigationLinks /></nav>
        </div>
      </header>
      <nav aria-label="Primary navigation" className="border-border bg-background fixed inset-x-0 bottom-0 z-20 border-t md:hidden">
        <div className="mx-auto flex max-w-lg items-stretch"><NavigationLinks mobile /></div>
      </nav>
    </>
  );
}
