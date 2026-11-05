import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { apiDelete, apiFetch, apiGet } from "../lib/api";

type Connection = {
  clientId: string;
  clientName: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
  /** Where the app sends you back to — "claude.ai", never a raw URL. */
  redirectHost: string;
  /** "token": a personal access token made here, for a bot that can't sign in. */
  kind?: "app" | "token";
};

/** A token as it comes back the one time it is shown. */
type Made = { token: string; name: string; url: string };

const field =
  "h-9 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-800 outline-none focus:border-teal-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100";

function access(r: Connection): string {
  const write = r.scopes.includes("agenda:write");
  const people = r.scopes.includes("people:read");
  if (people) return write ? "Can read and change agendas and people" : "Reads agendas and people";
  return write ? "Can read and change agendas" : "Read only";
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function lastUsed(iso: string | null): string {
  if (!iso) return "not used yet";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "used today";
  if (days === 1) return "used yesterday";
  return `used ${day(iso)}`;
}

/**
 * Apps (Claude, ChatGPT…) the signed-in user has approved over OAuth to read and
 * change their agendas through the MCP endpoint, and personal tokens made here
 * for bots that take a URL and a key instead. Revoking cuts every token that
 * app holds, immediately.
 */
export function ConnectedApps() {
  const [rows, setRows] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A server without the MCP endpoint answers 404: say nothing rather than offer a dead feature.
  const [absent, setAbsent] = useState(false);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [canChange, setCanChange] = useState(true);
  const [withPeople, setWithPeople] = useState(false);
  const [made, setMade] = useState<Made | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet("/api/mcp/connections");
      if (res.status === 404) {
        setAbsent(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { connections?: Connection[] };
      setRows(body.connections ?? []);
      setError(null);
    } catch {
      setError("Could not load connected apps.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (clientId: string) => {
    setBusyId(clientId);
    setError(null);
    try {
      const res = await apiDelete(`/api/mcp/connections/${encodeURIComponent(clientId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows((prev) => (prev ?? []).filter((r) => r.clientId !== clientId));
    } catch {
      setError("Could not disconnect that app. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const makeToken = async () => {
    setBusyId("new");
    setError(null);
    try {
      const res = await apiFetch("/api/mcp/tokens", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), access: canChange ? "write" : "read", people: withPeople }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Made> & { error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMade({ token: body.token, name: body.name ?? name.trim(), url: body.url ?? `${window.location.origin}/mcp` });
      setMaking(false);
      setName("");
      setWithPeople(false);
      setCanChange(true);
      void load();
    } catch (err) {
      setError(err instanceof Error && err.message && !err.message.startsWith("HTTP") ? `Could not make the token: ${err.message}.` : "Could not make the token. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  const copyToken = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.token);
    } catch {
      /* the token is on screen to select by hand */
    }
  };

  if (absent) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-stone-800 dark:text-stone-100">
        Connected apps
      </h3>
      <p className="text-xs leading-relaxed text-stone-500">
        Apps like Claude or ChatGPT you have allowed to read and change your
        agendas. They see health, prayer and assessment notes only if you
        tick that box when you connect them. Add Polarch in the app with{" "}
        <span className="font-mono text-stone-700 dark:text-stone-300">
          {typeof window === "undefined" ? "" : window.location.origin}/mcp
        </span>
        , or make a token for a bot that asks for a URL and a key.
      </p>
      {rows === null && !error && <p className="text-xs text-stone-500">Loading…</p>}
      {rows?.length === 0 && (
        <p className="text-xs text-stone-500">Nothing is connected.</p>
      )}
      <ul className="space-y-2">
        {rows?.map((r) => {
          return (
            <li
              key={r.clientId}
              className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50 p-3 dark:border-stone-700 dark:bg-stone-950/50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-stone-800 dark:text-stone-100">
                  {r.clientName}
                </p>
                <p className="text-xs text-stone-500">
                  {r.kind === "token" ? "Token · " : ""}
                  {access(r)}
                  {" · "}
                  {r.kind === "token" ? "made" : "connected"} {day(r.connectedAt)}
                  {" · "}
                  {lastUsed(r.lastUsedAt)}
                </p>
              </div>
              <Button
                size="sm"
                color="secondary-destructive"
                onClick={() => revoke(r.clientId)}
                isDisabled={busyId !== null}
                isLoading={busyId === r.clientId}
                aria-label={`${r.kind === "token" ? "Delete" : "Disconnect"} ${r.clientName}`}
              >
                {r.kind === "token" ? "Delete" : "Disconnect"}
              </Button>
            </li>
          );
        })}
      </ul>
      {made && (
        <div className="space-y-2 rounded-xl border border-teal-200 bg-teal-50 p-3 dark:border-teal-900 dark:bg-teal-950/40">
          <p className="text-xs text-stone-700 dark:text-stone-200">
            Give {made.name} this URL and token. The token is shown only now; if you lose it, delete it and make another.
          </p>
          <p className="font-mono text-xs text-stone-700 dark:text-stone-300">{made.url}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all truncate rounded-lg bg-white px-2 py-1.5 font-mono text-xs text-stone-800 dark:bg-stone-900 dark:text-stone-100">
              {made.token}
            </code>
            <Button size="sm" color="secondary" onClick={() => void copyToken()}>
              Copy
            </Button>
            <Button size="sm" color="tertiary" onClick={() => setMade(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {making ? (
        <form
          className="space-y-2 rounded-xl border border-stone-200 p-3 dark:border-stone-700"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void makeToken();
          }}
        >
          <input
            className={field}
            value={name}
            maxLength={60}
            placeholder="What it's for, e.g. Grokbot"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <Checkbox isSelected={canChange} onChange={setCanChange} label="Allow it to make changes" />
          <Checkbox
            isSelected={withPeople}
            onChange={setWithPeople}
            label="Include the people you lead"
            hint="Health ratings, prayer, assessments, notes, wins, goals, past write-ups and transcripts."
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" color="tertiary" onClick={() => setMaking(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" isDisabled={!name.trim() || busyId !== null} isLoading={busyId === "new"}>
              Make token
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" color="secondary" onClick={() => setMaking(true)} isDisabled={busyId !== null}>
          Make a token
        </Button>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </section>
  );
}
