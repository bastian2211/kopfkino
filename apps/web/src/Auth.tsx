import { useEffect, useState, type FormEvent } from "react";
import { api, errorCode, type Me } from "./api";
import { errText, t, type Lang } from "./i18n";
import { AdminUsers, BudgetCard, Statement } from "./Credits";
import { MyVideos } from "./Job";

// Anmelden mit Benutzername + Passwort
export function Login({ lang, onDone }: { lang: Lang; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { username, password } });
      onDone();
    } catch (err) {
      const code = errorCode(err);
      // Ungültiger Benutzername-Aufbau verrät nichts Neues – wie falsche Anmeldung behandeln
      setError(errText(lang, code === "username" ? "login_failed" : code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <h1>{t(lang, "loginTitle")}</h1>
      <label>
        {t(lang, "fUsername")}
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          required
        />
      </label>
      <label>
        {t(lang, "fPassword")}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      {error && <p className="err">{error}</p>}
      <button className="btn btn--coral" disabled={busy}>
        {busy ? "…" : t(lang, "loginBtn")}
      </button>
      <p className="hint">{t(lang, "loginInviteOnly")}</p>
    </form>
  );
}

// Konto über Einladungslink anlegen
export function Register({ lang, code, onDone }: { lang: Lang; code: string; onDone: () => void }) {
  const [valid, setValid] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ valid: boolean }>(`/api/auth/invite/${encodeURIComponent(code)}`)
      .then((r) => setValid(r.valid))
      .catch(() => setValid(false));
  }, [code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!adult) {
      setError(errText(lang, "adult_required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/register", {
        body: { invite: code, displayName, username, password, adult: true, locale: lang },
      });
      onDone();
    } catch (err) {
      setError(errText(lang, errorCode(err)));
    } finally {
      setBusy(false);
    }
  };

  if (valid === null) return <p className="hint">…</p>;
  if (!valid)
    return (
      <div className="form">
        <h1>{t(lang, "regTitle")}</h1>
        <p className="err">{errText(lang, "invite_invalid")}</p>
      </div>
    );

  return (
    <form className="form" onSubmit={submit}>
      <h1>{t(lang, "regTitle")}</h1>
      <p className="hint">{t(lang, "regIntro")}</p>
      <label>
        {t(lang, "fDisplayName")}
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} required />
      </label>
      <label>
        {t(lang, "fUsername")}
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          pattern="[a-z0-9._\-]{3,24}"
          title={t(lang, "fUsernameRule")}
          required
        />
        <small>{t(lang, "fUsernameRule")}</small>
      </label>
      <label>
        {t(lang, "fPassword")}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={10}
          required
        />
        <small>{t(lang, "fPasswordRule")}</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
        {t(lang, "fAdult")}
      </label>
      {error && <p className="err">{error}</p>}
      <button className="btn btn--coral" disabled={busy}>
        {busy ? "…" : t(lang, "regBtn")}
      </button>
    </form>
  );
}

// Nur für Admins: Einladungslink erzeugen und teilen
export function InviteFriend({ lang }: { lang: Lang }) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api<{ link: string; days: number }>("/api/admin/invites", { body: {} });
      setLink(r.link);
    } catch (err) {
      setStatus(errText(lang, errorCode(err)));
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!link) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Kopfkino", text: t(lang, "inviteShareText"), url: link });
        return;
      } catch {
        /* abgebrochen – kein Problem */
        return;
      }
    }
    await copy();
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setStatus(t(lang, "inviteCopied"));
    } catch {
      setStatus(t(lang, "inviteCopyFail"));
    }
  };

  return (
    <section className="card">
      <h2>{t(lang, "inviteTitle")}</h2>
      <p className="hint">{t(lang, "inviteHint")}</p>
      {!link ? (
        <button className="btn btn--coral" onClick={create} disabled={busy}>
          {busy ? "…" : t(lang, "inviteCreate")}
        </button>
      ) : (
        <>
          <p className="linkbox">{link}</p>
          <div className="row">
            <button className="btn btn--coral" onClick={share}>
              {t(lang, "shareBtn")}
            </button>
            <button className="btn" onClick={copy}>
              {t(lang, "inviteCopy")}
            </button>
          </div>
        </>
      )}
      {status && <p className="meta">{status}</p>}
    </section>
  );
}

// Konto-Bereich: wer bin ich, abmelden, ggf. einladen
export function Account({
  lang,
  me,
  onLogout,
  onBack,
  onBalanceChange,
  onOpenJob,
}: {
  lang: Lang;
  me: Me;
  onLogout: () => void;
  onBack: () => void;
  onBalanceChange: () => void;
  onOpenJob: (id: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => undefined);
    onLogout();
  };
  return (
    <div className="lab">
      <button className="back" onClick={onBack}>
        ← {t(lang, "back")}
      </button>
      <h1>{me.displayName}</h1>
      <p className="hint">
        @{me.username}
        {me.role === "admin" ? " · Admin" : ""}
      </p>
      <MyVideos lang={lang} onOpen={onOpenJob} />
      <Statement lang={lang} refreshKey={refresh} />
      {me.role === "admin" && (
        <>
          <h2 className="section">Admin</h2>
          <BudgetCard lang={lang} />
          <AdminUsers
            lang={lang}
            onBooked={() => {
              setRefresh((n) => n + 1);
              onBalanceChange();
            }}
          />
          <InviteFriend lang={lang} />
        </>
      )}
      <button className="btn" onClick={logout}>
        {t(lang, "logout")}
      </button>
    </div>
  );
}
