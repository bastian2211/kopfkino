import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorCode } from "./api";
import { errText, t, type Lang, type TextKey } from "./i18n";

export type Entry = {
  id: string;
  type: string;
  status: "open" | "settled" | "released" | null;
  credits: number;
  note: string | null;
  createdAt: string;
};

type CreditsPage = { balance: number; eurPerCredit: number; entries: Entry[]; hasMore: boolean };

export function formatCredits(n: number, lang: Lang): string {
  return n.toLocaleString(lang === "de" ? "de-DE" : "en-GB");
}

function signed(n: number, lang: Lang): string {
  return (n > 0 ? "+" : n < 0 ? "−" : "±") + formatCredits(Math.abs(n), lang);
}

function entryLabel(e: Entry): TextKey {
  if (e.type === "topup") return "lTopup";
  if (e.type === "admin_adjust") return "lAdjust";
  if (e.type === "refund") return "lRefund";
  if (e.status === "open") return "lReserved";
  if (e.status === "released") return "lReleased";
  return "lUsage";
}

// Kleines Abzeichen mit dem Kontostand (Startseite)
export function useBalance(enabled: boolean) {
  const [balance, setBalance] = useState<number | null>(null);
  const reload = useCallback(() => {
    if (!enabled) return;
    api<CreditsPage>("/api/credits")
      .then((r) => setBalance(r.balance))
      .catch(() => undefined);
  }, [enabled]);
  useEffect(reload, [reload]);
  return { balance, reload };
}

// Kontostand + Kontoauszug
export function Statement({ lang, refreshKey }: { lang: Lang; refreshKey: number }) {
  const [page, setPage] = useState<CreditsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    api<CreditsPage>("/api/credits")
      .then(setPage)
      .catch((err) => setError(errText(lang, errorCode(err))));
  }, [lang, refreshKey]);

  const more = async () => {
    if (!page) return;
    setLoadingMore(true);
    try {
      const last = page.entries[page.entries.length - 1];
      const next = await api<CreditsPage>(`/api/credits?before=${last?.id ?? ""}`);
      setPage({ ...next, entries: [...page.entries, ...next.entries] });
    } catch (err) {
      setError(errText(lang, errorCode(err)));
    } finally {
      setLoadingMore(false);
    }
  };

  const dateFmt = new Intl.DateTimeFormat(lang === "de" ? "de-DE" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <section className="card">
      <h2>{t(lang, "balanceTitle")}</h2>
      {error && <p className="err">{error}</p>}
      {page && (
        <>
          <p className="balance">
            {formatCredits(page.balance, lang)} <span>Credits</span>
          </p>
          <p className="hint-small">
            1 Credit = {eur(page.eurPerCredit, lang)}. {t(lang, "creditInfo")}
          </p>
          <h3>{t(lang, "statementTitle")}</h3>
          {page.entries.length === 0 ? (
            <p className="hint-small">{t(lang, "statementEmpty")}</p>
          ) : (
            <ul className="ledger">
              {page.entries.map((e) => (
                <li key={e.id}>
                  <div>
                    <strong>{t(lang, entryLabel(e))}</strong>
                    {e.note && <span className="ledger-note">{e.note}</span>}
                    <span className="ledger-date">{dateFmt.format(new Date(e.createdAt))}</span>
                  </div>
                  <span className={`ledger-amount ${e.credits > 0 ? "plus" : e.credits < 0 ? "minus" : ""}`}>
                    {signed(e.credits, lang)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {page.hasMore && (
            <button className="linkbtn" onClick={more} disabled={loadingMore}>
              {loadingMore ? "…" : t(lang, "loadMore")}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ---- Admin ----

type Budget = {
  month: string;
  capEur: number;
  spentEur: number;
  reservedEur: number;
  availableEur: number;
  markupPct: number;
  eurPerCredit: number;
  usdPerEur: number;
};

type AdminUser = { id: string; username: string; displayName: string; role: string; disabled: boolean; balance: number };

function eur(n: number, lang: Lang): string {
  return n.toLocaleString(lang === "de" ? "de-DE" : "en-GB", { style: "currency", currency: "EUR" });
}

export function BudgetCard({ lang }: { lang: Lang }) {
  const [b, setB] = useState<Budget | null>(null);
  useEffect(() => {
    api<Budget>("/api/admin/budget")
      .then(setB)
      .catch(() => undefined);
  }, []);
  if (!b) return null;
  const pct = (v: number) => `${Math.min(100, (v / b.capEur) * 100)}%`;
  return (
    <section className="card">
      <h2>{t(lang, "budgetTitle")}</h2>
      <div className="budgetbar" aria-hidden="true">
        <span className="spent" style={{ width: pct(b.spentEur) }} />
        <span className="reserved" style={{ width: pct(b.reservedEur) }} />
      </div>
      <ul className="budgetlist">
        <li>
          <span className="sw spent" /> {t(lang, "budgetSpent")} <b>{eur(b.spentEur, lang)}</b>
        </li>
        <li>
          <span className="sw reserved" /> {t(lang, "budgetReserved")} <b>{eur(b.reservedEur, lang)}</b>
        </li>
        <li>
          <span className="sw" /> {t(lang, "budgetFree")} <b>{eur(b.availableEur, lang)}</b> / {eur(b.capEur, lang)} ({b.month})
        </li>
      </ul>
      <p className="hint-small">
        {t(lang, "budgetRates")}: 1 Credit = {eur(b.eurPerCredit, lang)} · {t(lang, "budgetMarkup")} {b.markupPct} % · 1 € ={" "}
        {b.usdPerEur} $
      </p>
    </section>
  );
}

function BookingForm({ lang, user, onDone }: { lang: Lang; user: AdminUser; onDone: () => void }) {
  const [kind, setKind] = useState<"topup" | "adjust">("topup");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  // Ein Schlüssel pro Formular: zweimal tippen oder Netz-Wiederholung bucht trotzdem nur einmal
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const credits = Number(amount);
    if (!Number.isInteger(credits) || credits === 0 || (kind === "topup" && credits < 0)) {
      setError(errText(lang, "credits"));
      return;
    }
    const text = `${user.displayName}: ${signed(credits, lang)} Credits${note ? ` („${note}“)` : ""}?`;
    if (!window.confirm(text)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/credits", { body: { userId: user.id, kind, credits, note: note || undefined, key } });
      setKey(crypto.randomUUID());
      onDone();
    } catch (err) {
      setError(errText(lang, errorCode(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form booking" onSubmit={submit}>
      <div className="segmented">
        <button type="button" className={kind === "topup" ? "on" : ""} onClick={() => setKind("topup")}>
          {t(lang, "lTopup")}
        </button>
        <button type="button" className={kind === "adjust" ? "on" : ""} onClick={() => setKind("adjust")}>
          {t(lang, "lAdjust")}
        </button>
      </div>
      <label>
        Credits {kind === "adjust" ? t(lang, "adjustHint") : ""}
        <input
          inputMode={kind === "adjust" ? "text" : "numeric"}
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ""))}
          placeholder={kind === "topup" ? "500" : "-50"}
          required
        />
      </label>
      <label>
        {t(lang, "fNote")}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder={t(lang, "notePlaceholder")} />
      </label>
      {error && <p className="err">{error}</p>}
      <button className="btn btn--coral" disabled={busy}>
        {busy ? "…" : t(lang, "book")}
      </button>
    </form>
  );
}

export function AdminUsers({ lang, onBooked }: { lang: Lang; onBooked: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ users: AdminUser[] }>("/api/admin/users")
      .then((r) => setUsers(r.users))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  return (
    <section className="card">
      <h2>{t(lang, "usersTitle")}</h2>
      {flash && <p className="ok">{flash}</p>}
      {users?.map((u) => (
        <div key={u.id} className="userrow">
          <div className="userrow-head">
            <div>
              <strong>{u.displayName}</strong>
              <span className="ledger-note">
                @{u.username}
                {u.role === "admin" ? " · Admin" : ""}
              </span>
            </div>
            <span className="ledger-amount">{formatCredits(u.balance, lang)}</span>
            <button className="chip" onClick={() => setOpen(open === u.id ? null : u.id)}>
              {open === u.id ? "×" : "+"}
            </button>
          </div>
          {open === u.id && (
            <BookingForm
              lang={lang}
              user={u}
              onDone={() => {
                setOpen(null);
                setFlash(`${t(lang, "booked")}: ${u.displayName}`);
                load();
                onBooked();
              }}
            />
          )}
        </div>
      ))}
    </section>
  );
}
