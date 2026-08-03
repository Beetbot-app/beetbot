/**
 * The install sheet.
 *
 * Two platforms, and the difference is not cosmetic: on iOS there is no install
 * API, so instructions are the only honest thing to show. Offering a button that
 * cannot exist would be worse than saying nothing.
 *
 * And it must appear exactly once. A prompt that returns every visit is an
 * advert, and this one interrupts somebody who has just arrived from a friend's
 * invitation.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { InstallSheet } from './InstallSheet';
import { DISMISSED_KEY } from '../lib/install';
import { mockMatchMedia } from '../../test/setup';

/** Put the page on a phone, in a browser tab. */
function onAPhone({ ios = true }: { ios?: boolean } = {}) {
  mockMatchMedia((q) => q.includes('pointer: coarse'));
  window.innerWidth = 390;
  vi.spyOn(window, 'navigator', 'get').mockReturnValue({
    ...window.navigator,
    userAgent: ios
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
      : 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
    maxTouchPoints: 5,
  } as Navigator);
}

/** Hand the component a Chromium install prompt, as the browser would. */
function fireInstallPrompt() {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt') as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  // Wrapped: the listener sets state, and React wants that inside act() so the
  // re-render has settled before anything asserts on it.
  act(() => {
    window.dispatchEvent(event);
  });
  return prompt;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('when it appears', () => {
  test('a phone, in a tab, first visit', async () => {
    onAPhone();
    render(<InstallSheet />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  test('never on a desktop browser', () => {
    render(<InstallSheet />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('never once it is already installed', () => {
    // Suggesting it here would read as "that didn't work".
    mockMatchMedia((q) => q.includes('pointer: coarse') || q.includes('display-mode: standalone'));
    window.innerWidth = 390;
    render(<InstallSheet />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('never again after it has been dismissed', () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    onAPhone();
    render(<InstallSheet />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('unless Settings asks for it, which ignores the dismissal', async () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    onAPhone();
    render(<InstallSheet forced />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('iOS, where there is no install API', () => {
  test('shows the steps and offers no button that cannot work', async () => {
    onAPhone({ ios: true });
    render(<InstallSheet />);

    await screen.findByRole('dialog');
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  test('even when the browser somehow offers a prompt', async () => {
    onAPhone({ ios: true });
    render(<InstallSheet />);
    await screen.findByRole('dialog');
    fireInstallPrompt();

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument(),
    );
  });
});

describe('Chromium, where there is one', () => {
  test('falls back to instructions until the prompt arrives', async () => {
    onAPhone({ ios: false });
    render(<InstallSheet />);

    await screen.findByRole('dialog');
    expect(screen.getByText(/Add to Home Screen/i)).toBeInTheDocument();
  });

  test('offers a real button once it does, and uses it', async () => {
    const user = userEvent.setup();
    onAPhone({ ios: false });
    render(<InstallSheet />);
    await screen.findByRole('dialog');

    const prompt = fireInstallPrompt();
    const button = await screen.findByRole('button', { name: 'Install' });
    await user.click(button);

    await waitFor(() => expect(prompt).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('dismissing', () => {
  test('closes it and remembers', async () => {
    const user = userEvent.setup();
    onAPhone();
    render(<InstallSheet />);

    await user.click(await screen.findByRole('button', { name: 'Got it' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });

  test('tapping the backdrop dismisses too', async () => {
    const user = userEvent.setup();
    onAPhone();
    render(<InstallSheet />);

    await user.click(await screen.findByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('tapping the card itself does NOT', async () => {
    // Reading the instructions means touching the thing the instructions are on.
    const user = userEvent.setup();
    onAPhone();
    render(<InstallSheet />);

    await screen.findByRole('dialog');
    await user.click(screen.getByText(/Keep Beetbot on your home screen/i));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('tells Settings it closed, so the row can be tapped again', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    onAPhone();
    render(<InstallSheet forced onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(onClose).toHaveBeenCalled();
  });
});
