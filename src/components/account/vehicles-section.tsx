"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { toast } from "sonner";
import { Car, Star } from "lucide-react";
import { CreateVehicleBody, type Preferences, type Vehicle } from "@/contracts";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { applyServerErrors, DANGER, Field, Section } from "./field";

const TYPE_LABELS: Record<Vehicle["type"], string> = {
  TWO_WHEELER: "Two-wheeler",
  HATCHBACK: "Hatchback",
  SEDAN: "Sedan",
  SUV: "SUV",
  VAN: "Van",
};

type FormIn = z.input<typeof CreateVehicleBody>;
type FormOut = z.output<typeof CreateVehicleBody>;
const FIELDS = ["registration", "type", "nickname", "heightCm", "widthCm", "lengthCm"] as const;
const DIMENSIONS = [
  ["heightCm", "Height (cm)"],
  ["widthCm", "Width (cm)"],
  ["lengthCm", "Length (cm)"],
] as const;

const toNumberOrNull = (v: unknown) => (v === "" || v == null ? null : Number(v));

function VehicleForm({
  vehicle,
  onSaved,
  onCancel,
}: {
  vehicle?: Vehicle;
  onSaved: (v: Vehicle) => void;
  onCancel: () => void;
}) {
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(CreateVehicleBody),
    // The body is a strict object, so the vehicle's id must not ride along.
    defaultValues: vehicle
      ? Object.fromEntries(FIELDS.map((f) => [f, vehicle[f]]))
      : { registration: "", type: "HATCHBACK", nickname: null },
  });
  const { errors, isSubmitting } = form.formState;
  const registration = form.register("registration");

  async function onSubmit(body: FormOut) {
    try {
      onSaved(
        vehicle
          ? await api<Vehicle>(`/api/me/vehicles/${vehicle.id}`, { method: "PATCH", body })
          : await api<Vehicle>("/api/me/vehicles", { method: "POST", body }),
      );
    } catch (e) {
      if (!applyServerErrors(e, FIELDS, form.setError, "registration"))
        toast.error("Couldn't save the vehicle. Try again.");
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field
        id="vehicle-registration"
        label="Registration number"
        hint="e.g. MH12AB1234 or 22BH1234AB"
        error={errors.registration}
      >
        {(p) => (
          <Input
            {...p}
            {...registration}
            onChange={(e) => {
              e.target.value = e.target.value.toUpperCase();
              return registration.onChange(e);
            }}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="h-11 font-mono"
          />
        )}
      </Field>
      <Field id="vehicle-type" label="Vehicle type" error={errors.type}>
        {(p) => (
          <select
            {...p}
            {...form.register("type")}
            className="border-input bg-background focus-visible:ring-ring/50 aria-invalid:border-destructive h-11 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3"
          >
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id="vehicle-nickname" label="Nickname (optional)" error={errors.nickname}>
        {(p) => (
          <Input
            {...p}
            {...form.register("nickname", {
              setValueAs: (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null),
            })}
            className="h-11"
          />
        )}
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Dimensions (optional)</legend>
        <p id="vehicle-dimensions-hint" className="text-muted-foreground text-xs">
          Needed for height-restricted spaces.
        </p>
        <div className="grid grid-cols-3 gap-2">
          {DIMENSIONS.map(([name, label]) => (
            <Field key={name} id={`vehicle-${name}`} label={label} error={errors[name]}>
              {(p) => (
                <Input
                  {...p}
                  {...form.register(name, { setValueAs: toNumberOrNull })}
                  aria-describedby={[p["aria-describedby"], "vehicle-dimensions-hint"].join(" ")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  className="h-11"
                />
              )}
            </Field>
          ))}
        </div>
      </fieldset>
      <DialogFooter>
        <Button type="button" variant="outline" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : vehicle ? "Save changes" : "Add vehicle"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function VehiclesSection({
  initialVehicles,
  initialDefaultId,
}: {
  initialVehicles: Vehicle[];
  initialDefaultId: string | null;
}) {
  const [vehicles, setVehicles] = useState(initialVehicles);
  const [defaultId, setDefaultId] = useState(initialDefaultId);
  const [editing, setEditing] = useState<Vehicle | "new" | null>(null);
  const [deleting, setDeleting] = useState<Vehicle | null>(null);
  const [busy, setBusy] = useState(false);

  function saved(v: Vehicle) {
    setVehicles((list) =>
      list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v],
    );
    toast.success(editing === "new" ? "Vehicle added" : "Vehicle updated");
    setEditing(null);
  }

  async function toggleDefault(v: Vehicle) {
    const previous = defaultId;
    const next = previous === v.id ? null : v.id;
    setDefaultId(next);
    try {
      await api<Preferences>("/api/me/preferences", {
        method: "PATCH",
        body: { defaultVehicleId: next },
      });
      toast.success(next ? `${v.registration} is your default vehicle` : "Default vehicle cleared");
    } catch {
      setDefaultId(previous);
      toast.error("Couldn't change your default vehicle. Try again.");
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/me/vehicles/${deleting.id}`, { method: "DELETE" });
      setVehicles((list) => list.filter((x) => x.id !== deleting.id));
      if (defaultId === deleting.id) setDefaultId(null);
      toast.success(`${deleting.registration} removed`);
      setDeleting(null);
    } catch {
      toast.error("Couldn't remove the vehicle. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Vehicles"
      action={
        vehicles.length > 0 && (
          <Button className="h-11" onClick={() => setEditing("new")}>
            Add vehicle
          </Button>
        )
      }
    >
      {vehicles.length === 0 ? (
        <EmptyState
          icon={Car}
          title="No vehicles yet"
          body="Add a vehicle so hosts know what to expect and you can book faster."
          action={
            <Button className="h-11" onClick={() => setEditing("new")}>
              Add vehicle
            </Button>
          }
        />
      ) : (
        <ul className="divide-y">
          {vehicles.map((v) => {
            const isDefault = v.id === defaultId;
            const dims = [v.heightCm, v.widthCm, v.lengthCm].some(Boolean)
              ? `${v.heightCm ?? "–"} × ${v.widthCm ?? "–"} × ${v.lengthCm ?? "–"} cm (H × W × L)`
              : null;
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono font-semibold">{v.registration}</p>
                  <p className="text-muted-foreground text-sm">
                    {[v.nickname, TYPE_LABELS[v.type], dims].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={isDefault ? "secondary" : "outline"}
                    className="h-11"
                    aria-pressed={isDefault}
                    aria-label={`Default ${v.registration}`}
                    onClick={() => toggleDefault(v)}
                  >
                    <Star aria-hidden="true" className={isDefault ? "fill-current" : undefined} />
                    Default
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11"
                    aria-label={`Edit ${v.registration}`}
                    onClick={() => setEditing(v)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    className="text-destructive h-11"
                    aria-label={`Delete ${v.registration}`}
                    onClick={() => setDeleting(v)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "Add a vehicle" : "Edit vehicle"}</DialogTitle>
          </DialogHeader>
          {editing !== null && (
            <VehicleForm
              key={editing === "new" ? "new" : editing.id}
              vehicle={editing === "new" ? undefined : editing}
              onSaved={saved}
              onCancel={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.registration}?</DialogTitle>
            <DialogDescription>
              It will no longer be offered at checkout. Past bookings keep their vehicle details.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className={DANGER}
              disabled={busy}
              onClick={confirmDelete}
            >
              {busy ? "Deleting…" : "Delete vehicle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
