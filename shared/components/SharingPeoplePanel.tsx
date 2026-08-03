/**
 * Who else can open this server — the same panel on the desktop and the phone.
 *
 * One component for both because the owner is as likely to want this from a sofa
 * as from the Mac: they think of somebody, they invite them. Making it a
 * desktop-only act would mean the phone is where you notice you want to share and
 * the Mac is where you have to go to do it.
 *
 * Provider-agnostic. Nothing here names a service — the name arrives in the
 * status response and the copy is written around it, so this reads correctly
 * whoever supplies the sharing. In a build with no provider the panel renders
 * nothing at all, and a visitor who is not the owner never sees it either.
 *
 * Removing somebody always asks first, and asks INLINE rather than through a
 * native dialog: this component is shared by a Tauri webview and a phone browser,
 * and the row turning into "Remove them? Cancel / Remove" behaves the same in
 * both. It cannot be undone without sending a fresh invitation, and a stray tap
 * in a list is exactly how that would happen.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { ensureSession, getStoredToken } from '../api';
import {
  getSharedPeople,
  getSharingStatus,
  invitePerson,
  revokePerson,
  type SharedPerson,
} from '../sharing';
import { cn, BTN_PRIMARY, BTN_GHOST, BTN_DANGER, CALLOUT_ERROR, INPUT } from '../ui';
import { Group, Row } from './SettingsKit';

/** How somebody's standing reads in the list. */
function standing(p: SharedPerson): string {
  return p.accepted ? 'Has access' : 'Invited';
}

export function SharingPeoplePanel(): ReactElement | null {
  const [canManage, setCanManage] = useState(false);
  const [providerName, setProviderName] = useState('');
  const [people, setPeople] = useState<SharedPerson[]>([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // The session token, however this surface happens to hold one.
  useEffect(() => {
    let live = true;
    const stored = getStoredToken();
    if (stored) {
      setToken(stored);
      return;
    }
    void ensureSession()
      .then((t) => {
        if (live) setToken(t);
      })
      .catch(() => {
        /* no session yet — the panel stays hidden, which is the honest state */
      });
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    const status = await getSharingStatus(token).catch(() => null);
    if (!status?.canManage) {
      setCanManage(false);
      return;
    }
    setCanManage(true);
    setProviderName(status.providerName);
    const listed = await getSharedPeople(token).catch(() => null);
    if (listed) setPeople(listed.people);
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onInvite = useCallback(async () => {
    if (!token) return;
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      await invitePerson(address, token);
      setEmail('');
      await refresh();
    } catch (e) {
      // The server's own wording, which is the part that says what to do next.
      setError(e instanceof Error ? e.message : 'Could not send that invitation.');
    } finally {
      setBusy(false);
    }
  }, [email, refresh, token]);

  const onRemove = useCallback(
    async (person: SharedPerson) => {
      if (!token) return;
      setBusy(true);
      setError(null);
      try {
        await revokePerson(person.accountId, token);
        setConfirming(null);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not remove that person.');
      } finally {
        setBusy(false);
      }
    },
    [refresh, token],
  );

  // No provider, or a visitor rather than the owner. Nothing to show, and no
  // hint that something is being withheld.
  if (!canManage) return null;

  const guests = people.filter((p) => !p.isOwner);

  return (
    <Group
      label="People"
      description="Anyone you invite can play your music from their own devices."
      footer={
        providerName
          ? `They sign in with ${providerName}, and see only your music.`
          : 'They see only your music.'
      }
    >
      <div className="flex gap-2">
        <input
          className={cn(INPUT, 'flex-1')}
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          placeholder="their@email.com"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onInvite();
          }}
        />
        <button
          className={BTN_PRIMARY}
          disabled={busy || !email.trim()}
          onClick={() => void onInvite()}
        >
          Invite
        </button>
      </div>
      {error ? <p className={cn(CALLOUT_ERROR, 'mt-3')}>{error}</p> : null}

      {guests.length === 0 ? (
        <Row
          divider
          label="Nobody else yet"
          secondary="Invite someone and they'll get an email with a link."
        />
      ) : (
        guests.map((p) =>
          confirming === p.accountId ? (
            <Row
              key={p.accountId}
              divider
              label={`Remove ${p.email}?`}
              secondary="They'll lose access within a few seconds. You can invite them again later."
              control={
                <>
                  <button
                    className={BTN_GHOST}
                    disabled={busy}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className={BTN_DANGER}
                    disabled={busy}
                    onClick={() => void onRemove(p)}
                  >
                    Remove
                  </button>
                </>
              }
            />
          ) : (
            <Row
              key={p.accountId}
              divider
              label={p.email}
              title={p.email}
              secondary={standing(p)}
              control={
                <button
                  className={BTN_GHOST}
                  disabled={busy}
                  aria-label={`Remove ${p.email}`}
                  onClick={() => setConfirming(p.accountId)}
                >
                  Remove
                </button>
              }
            />
          ),
        )
      )}
    </Group>
  );
}
