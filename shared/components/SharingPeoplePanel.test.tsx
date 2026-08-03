/**
 * The People panel.
 *
 * The two claims worth testing are about what does NOT happen:
 *
 * 1. **It renders nothing unless the server says this caller may manage.** A
 *    guest's phone must show no trace of it — not a disabled section, not an
 *    error, nothing. Anything else tells them a control exists that they cannot
 *    have, on somebody else's computer.
 *
 * 2. **Removing somebody cannot happen on one tap.** It ends access and cannot be
 *    undone without a fresh invitation, and a list of rows on a phone is exactly
 *    where a stray touch lands.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { SharingPeoplePanel } from './SharingPeoplePanel';

vi.mock('../api', () => ({
  getStoredToken: () => 'tok-123',
  ensureSession: async () => 'tok-123',
  apiUrl: (p: string) => p,
}));

const getSharingStatus = vi.fn();
const getSharedPeople = vi.fn();
const invitePerson = vi.fn();
const revokePerson = vi.fn();

vi.mock('../sharing', () => ({
  getSharingStatus: (...a: unknown[]) => getSharingStatus(...a),
  getSharedPeople: (...a: unknown[]) => getSharedPeople(...a),
  invitePerson: (...a: unknown[]) => invitePerson(...a),
  revokePerson: (...a: unknown[]) => revokePerson(...a),
}));

const OWNER = { email: 'me@example.com', accountId: 'a1', isOwner: true, accepted: true };
const GUEST = { email: 'sam@example.com', accountId: 'a2', isOwner: false, accepted: true };
const INVITED = { email: 'new@example.com', accountId: 'a3', isOwner: false, accepted: false };

/** The owner, with whoever is passed in. */
function serverSays(people: Array<typeof OWNER>) {
  getSharingStatus.mockResolvedValue({ canManage: true, providerName: 'Sharemate' });
  getSharedPeople.mockResolvedValue({ providerName: 'Sharemate', people });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('who sees it', () => {
  test('a guest sees no trace of it', async () => {
    getSharingStatus.mockResolvedValue({ canManage: false, providerName: '' });
    const { container } = render(<SharingPeoplePanel />);

    await waitFor(() => expect(getSharingStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(getSharedPeople).not.toHaveBeenCalled();
  });

  test('a build with no provider renders nothing either', async () => {
    getSharingStatus.mockRejectedValue(new Error('sharing is not available'));
    const { container } = render(<SharingPeoplePanel />);

    await waitFor(() => expect(getSharingStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  test('the owner sees the panel, named after whoever provides it', async () => {
    serverSays([OWNER]);
    render(<SharingPeoplePanel />);

    expect(await screen.findByText('People')).toBeInTheDocument();
    expect(screen.getByText(/sign in with Sharemate/i)).toBeInTheDocument();
  });
});

describe('the list', () => {
  test('the owner is not listed as somebody they could remove', async () => {
    serverSays([OWNER, GUEST]);
    render(<SharingPeoplePanel />);

    expect(await screen.findByText(GUEST.email)).toBeInTheDocument();
    expect(screen.queryByText(OWNER.email)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(1);
  });

  test('an outstanding invitation does not read as having access', async () => {
    serverSays([OWNER, INVITED]);
    render(<SharingPeoplePanel />);

    expect(await screen.findByText(INVITED.email)).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.queryByText('Has access')).not.toBeInTheDocument();
  });

  test('with nobody shared yet it says so, rather than showing an empty box', async () => {
    serverSays([OWNER]);
    render(<SharingPeoplePanel />);
    expect(await screen.findByText(/Nobody else yet/i)).toBeInTheDocument();
  });
});

describe('inviting', () => {
  test('sends the address and clears the field', async () => {
    const user = userEvent.setup();
    serverSays([OWNER]);
    invitePerson.mockResolvedValue(undefined);
    render(<SharingPeoplePanel />);

    const field = await screen.findByPlaceholderText('their@email.com');
    await user.type(field, 'sam@example.com');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    await waitFor(() => expect(invitePerson).toHaveBeenCalledWith('sam@example.com', 'tok-123'));
    await waitFor(() => expect(field).toHaveValue(''));
  });

  test('an empty field cannot be sent', async () => {
    serverSays([OWNER]);
    render(<SharingPeoplePanel />);
    expect(await screen.findByRole('button', { name: 'Invite' })).toBeDisabled();
  });

  test("the server's refusal is shown in its own words", async () => {
    const user = userEvent.setup();
    serverSays([OWNER]);
    invitePerson.mockRejectedValue(new Error('that does not look like an email address'));
    render(<SharingPeoplePanel />);

    await user.type(await screen.findByPlaceholderText('their@email.com'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(
      await screen.findByText('that does not look like an email address'),
    ).toBeInTheDocument();
  });
});

describe('removing somebody', () => {
  test('THE RULE: one tap asks, it does not remove', async () => {
    const user = userEvent.setup();
    serverSays([OWNER, GUEST]);
    render(<SharingPeoplePanel />);

    await user.click(await screen.findByRole('button', { name: `Remove ${GUEST.email}` }));

    expect(revokePerson).not.toHaveBeenCalled();
    expect(screen.getByText(`Remove ${GUEST.email}?`)).toBeInTheDocument();
    expect(screen.getByText(/lose access within a few seconds/i)).toBeInTheDocument();
  });

  test('the second tap is the one that does it', async () => {
    const user = userEvent.setup();
    serverSays([OWNER, GUEST]);
    revokePerson.mockResolvedValue(undefined);
    render(<SharingPeoplePanel />);

    await user.click(await screen.findByRole('button', { name: `Remove ${GUEST.email}` }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(revokePerson).toHaveBeenCalledWith(GUEST.accountId, 'tok-123'));
  });

  test('changing your mind removes nobody', async () => {
    const user = userEvent.setup();
    serverSays([OWNER, GUEST]);
    render(<SharingPeoplePanel />);

    await user.click(await screen.findByRole('button', { name: `Remove ${GUEST.email}` }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(revokePerson).not.toHaveBeenCalled();
    expect(screen.getByText(GUEST.email)).toBeInTheDocument();
  });

  test('a failed removal says why, and leaves them there', async () => {
    const user = userEvent.setup();
    serverSays([OWNER, GUEST]);
    revokePerson.mockRejectedValue(new Error('no such member'));
    render(<SharingPeoplePanel />);

    await user.click(await screen.findByRole('button', { name: `Remove ${GUEST.email}` }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('no such member')).toBeInTheDocument();
  });
});
