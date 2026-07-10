/**
 * Spotify-style "now playing" equalizer: a few thin bars that bounce
 * rhythmically while music plays and sit still (short) when paused. Purely
 * decorative — used as the now-playing indicator in the queue instead of a
 * static play triangle. Colour comes from the parent's text color (bg-current),
 * so wrap it in e.g. `text-accent`. The keyframe is injected inline so the
 * component is self-contained across every bundle (no global stylesheet edit).
 */
export function EqualizerBars({
  playing = true,
  className = '',
}: {
  playing?: boolean;
  className?: string;
}) {
  const bars = [
    { dur: '0.9s', delay: '0s' },
    { dur: '1.15s', delay: '0.25s' },
    { dur: '0.8s', delay: '0.1s' },
    { dur: '1.05s', delay: '0.4s' },
  ];
  return (
    <span className={`inline-flex items-end gap-[2px] h-[15px] ${className}`} aria-hidden>
      {bars.map((b, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-current"
          style={{
            height: '100%',
            transformOrigin: 'bottom',
            transform: playing ? undefined : 'scaleY(0.3)',
            animation: playing ? `mrdm-eq ${b.dur} ease-in-out ${b.delay} infinite` : 'none',
          }}
        />
      ))}
      <style>{`@keyframes mrdm-eq{0%,100%{transform:scaleY(0.3)}50%{transform:scaleY(1)}}@media(prefers-reduced-motion:reduce){[style*="mrdm-eq"]{animation:none!important;transform:scaleY(0.6)!important}}`}</style>
    </span>
  );
}
