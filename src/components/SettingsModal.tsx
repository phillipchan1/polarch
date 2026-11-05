import { useState } from "react";
import { useStore } from "../store/useStore";
import { Toggle } from "@/components/base/toggle/toggle";
import { Modal } from "./ui";
import { Button } from "@/components/base/buttons/button";
import { ConnectedApps } from "./ConnectedApps";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const userEmail = useStore((s) => s.userEmail);
  const dark = useStore((s) => s.dark);
  const toggleDark = useStore((s) => s.toggleDark);
  const signOut = useStore((s) => s.signOut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignOut = async () => {
    setError(null);
    setBusy(true);
    try {
      await signOut();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign out.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-stone-800 dark:text-stone-100">
            Account
          </h3>
          <p className="text-xs leading-relaxed text-stone-500">
            Signed in with a magic-link email. Your org data syncs to the cloud
            and stays private to this account.
          </p>
          <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 dark:border-stone-700 dark:bg-stone-950/50">
            <p className="text-caption font-medium uppercase tracking-wide text-quaternary">
              Signed in as
            </p>
            <p className="mt-0.5 text-sm text-stone-800 dark:text-stone-100">
              {userEmail ?? "this account"}
            </p>
          </div>
          <Button
            size="md"
            color="secondary-destructive"
            className="w-full"
            onClick={onSignOut}
            isDisabled={busy}
            isLoading={busy}
            showTextWhileLoading
          >
            {busy ? "Signing out…" : "Sign out"}
          </Button>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </section>

        <ConnectedApps />

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-stone-800 dark:text-stone-100">
            Appearance
          </h3>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-stone-700 dark:text-stone-200">
                Dark mode
              </p>
              <p className="text-xs text-stone-500">
                Preference stays on this device.
              </p>
            </div>
            <Toggle
              size="sm"
              isSelected={dark}
              onChange={toggleDark}
              aria-label="Dark mode"
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}
