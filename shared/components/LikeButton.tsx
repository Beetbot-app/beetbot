interface Props {
  liked: boolean;
  onToggle: () => void;
  /** Icon size in px. */
  size?: number;
  className?: string;
  /**
   * Override the accessible label/title. When set, the button is treated as a
   * dialog trigger (opens a picker) rather than a like-toggle — `aria-pressed`
   * is dropped and `aria-haspopup="dialog"` is set instead. The now-playing
   * star uses this: it opens an "Add to playlist" picker rather than toggling
   * Favorites directly. Omit it and the button keeps plain toggle semantics.
   */
  label?: string;
}

/**
 * Favorite toggle — a star, filled (bright) when the track is in Favorites,
 * hollow otherwise (Apple Music-style). Presentational: the parent owns the
 * liked state and the API call.
 */
export function LikeButton({ liked, onToggle, size = 22, className, label }: Props) {
  const isTrigger = label != null;
  const text = label ?? (liked ? 'Remove from Favorites' : 'Add to Favorites');
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={text}
      aria-pressed={isTrigger ? undefined : liked}
      aria-haspopup={isTrigger ? 'dialog' : undefined}
      title={text}
      className={`grid place-items-center rounded-full transition ${
        liked
          ? 'text-white'
          : 'text-white/70 hover:text-white'
      } ${className ?? ''}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={liked ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 2.6l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
      </svg>
    </button>
  );
}
