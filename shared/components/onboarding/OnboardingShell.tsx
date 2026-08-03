import { type ReactNode } from 'react';
import { HeroWash } from '@shared/components/HeroWash';
import { cn, BTN_GHOST } from '@shared/ui';
import { Wordmark } from '@shared/components/Wordmark';

/**
 * The room every onboarding step stands in: a full-bleed surface that glows in
 * the color of whatever artwork the step is pointing at.
 *
 * Shared because the guest's phone wizard and the owner's desktop wizard are the
 * same room with different furniture — and because the wordmark landing in the
 * same spot on both is what makes gate → onboarding → app feel like one move.
 */
export function OnboardingShell({
  coverUrl,
  onSkip,
  footer,
  children,
}: {
  /** Artwork the backdrop blooms from — usually `taste.activeArt`. */
  coverUrl: string | null;
  /** Top-right "Skip". Omitted → no escape hatch is offered. */
  onSkip?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-neutral-950">
      {/* The signature: the room glows in the color of the artist under the
       *  cursor (or the last one picked). Same wash as the window + every hero. */}
      <HeroWash coverUrl={coverUrl} />
      <div className="relative z-10 flex h-full flex-col">
        <header className="relative flex shrink-0 items-center justify-between px-8 pt-7">
          {/* The overlay covers the app's title bar, so without this the window
           *  can't be dragged while onboarding is up. Give the header strip back
           *  its drag region — same trick the full-screen Now Playing view uses.
           *  Inert in the browser (no Tauri), so the phone wizard is unaffected.
           *  Controls below are `relative` so they stay clickable above it. */}
          <div data-tauri-drag-region aria-hidden className="absolute inset-0" />
          <Wordmark />
          {onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              className={cn(BTN_GHOST, 'relative')}
            >
              Skip
            </button>
          ) : null}
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-8">
          <div className="grid min-h-full place-items-center py-8">
            <div className="w-full max-w-2xl">{children}</div>
          </div>
        </main>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-between px-8 pt-4 pb-7">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/** The step dots. `steps` is the host's own list, so a two-step guest flow and a
 *  three-step owner flow each show an honest count. */
export function StepDots({ steps, step }: { steps: readonly string[]; step: string }) {
  return (
    <div className="flex gap-1.5">
      {steps.map((s) => (
        <span
          key={s}
          className={cn(
            'h-1.5 w-6 rounded-full transition',
            s === step ? 'bg-white' : 'bg-white/20',
          )}
        />
      ))}
    </div>
  );
}
