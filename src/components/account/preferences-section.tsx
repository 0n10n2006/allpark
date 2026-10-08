"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { NotificationSettings, Preferences } from "@/contracts";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api-client";
import { Section } from "./field";

type Key = keyof NotificationSettings;

// ponytail: the contract has one email switch, not one per category; split it when
// NotificationSettings grows per-category keys.
const GROUPS: { title: string; items: { key: Key; label: string; description: string }[] }[] = [
  {
    title: "Email",
    items: [
      {
        key: "email",
        label: "Booking and account emails",
        description: "Confirmations, changes, cancellations, payouts and receipts.",
      },
      {
        key: "marketing",
        label: "Offers and product news",
        description: "Occasional emails about new features and promotions.",
      },
    ],
  },
  {
    title: "Reminders",
    items: [
      {
        key: "sessionReminders",
        label: "Parking session reminders",
        description: "A heads-up before your booked time ends.",
      },
    ],
  },
];

function Row({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  // The whole row is the label, so the touch target is 44px+ even though the switch is small.
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-2 has-data-disabled:cursor-default">
      <span>
        <span id={`${id}-label`} className="block font-medium">
          {label}
        </span>
        <span id={`${id}-desc`} className="text-muted-foreground block text-sm">
          {description}
        </span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-desc`}
      />
    </label>
  );
}

export function PreferencesSection({ initial }: { initial: NotificationSettings }) {
  const [settings, setSettings] = useState(initial);

  async function toggle(key: Key, value: boolean) {
    // Functional updates, so overlapping toggles of different keys don't clobber each other.
    setSettings((s) => ({ ...s, [key]: value }));
    try {
      await api<Preferences>("/api/me/preferences", {
        method: "PATCH",
        body: { notifications: { [key]: value } },
      });
      toast.success("Preferences saved");
    } catch {
      setSettings((s) => ({ ...s, [key]: !value }));
      toast.error("Couldn't save your preferences. Try again.");
    }
  }

  return (
    <Section title="Notifications">
      <div className="space-y-6">
        {GROUPS.map((group) => (
          <fieldset key={group.title} className="space-y-1">
            <legend className="text-muted-foreground mb-1 text-sm font-semibold tracking-wide uppercase">
              {group.title}
            </legend>
            {group.items.map((item) => (
              <Row
                key={item.key}
                id={`pref-${item.key}`}
                label={item.label}
                description={item.description}
                checked={settings[item.key]}
                onChange={(v) => toggle(item.key, v)}
              />
            ))}
          </fieldset>
        ))}
        <fieldset className="space-y-1">
          <legend className="text-muted-foreground mb-1 text-sm font-semibold tracking-wide uppercase">
            In-app
          </legend>
          <Row
            id="pref-inApp"
            label="In-app notifications"
            description="Always on, so you never miss booking updates."
            checked
            disabled
          />
        </fieldset>
      </div>
    </Section>
  );
}
