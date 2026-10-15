/**
 * The button.
 *
 * `cva` because this component has genuine variants - intent and size - that deserve a
 * typed API, which is exactly the split the library list draws: `clsx` for ad-hoc
 * conditional classes, `cva` when the variants are real. Everything else in this app uses
 * `clsx`.
 *
 * Two motion decisions, and both are deliberate rather than defaults.
 *
 * **`scale(0.97)` on `:active`, at 160ms.** A button has to feel like the interface heard
 * the press. Without it the only feedback is whatever the click eventually causes, which on
 * a slow request is nothing for half a second - and the user presses again. The scale is
 * subtle on purpose: anything below about 0.95 reads as a toy.
 *
 * **Only `transform` and `opacity` are transitioned**, and they are named individually.
 * `transition: all` would animate properties nobody chose, including layout ones that cost
 * a reflow every frame.
 *
 * Note what does NOT animate: the hover state's colour change is instant on touch devices,
 * because the hover rules sit behind `(hover: hover) and (pointer: fine)`. A touch device
 * fires hover on tap, so without that gate every tap leaves a button stuck looking hovered
 * until something else is touched.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const button = cva(
  [
    'inline-flex items-center justify-center gap-2 rounded-md font-medium',
    'transition-[transform,opacity,background-color,border-color] duration-(--duration-press) ease-(--ease-out)',
    // The press feedback. `active:` rather than a JS handler so it responds to the pointer
    // going down rather than to a click completing, which is what makes it feel immediate.
    'active:scale-[0.97]',
    // Disabled buttons must not look pressable. No scale, no pointer, and enough opacity
    // loss to read as unavailable without becoming illegible.
    'disabled:pointer-events-none disabled:opacity-50 disabled:active:scale-100',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400',
  ],
  {
    variants: {
      intent: {
        // hover: needs no media-query guard in Tailwind v4 - the framework compiles the
        // variant to @media (hover: hover) itself, which is a v4 change from v3 and the
        // reason there is no hand-written guard here. Verified by grepping the built CSS
        // rather than taken on trust; see the check in implementation.md.
        primary: ['bg-brand-600 text-white hover:bg-brand-500'],
        secondary: ['bg-ink-800 text-ink-100 border border-ink-700 hover:bg-ink-700'],
        ghost: ['bg-transparent text-ink-300 border border-transparent hover:bg-ink-800 hover:text-ink-100'],
        danger: ['bg-bad-600 text-white hover:bg-bad-500'],
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-sm',
      },
    },
    defaultVariants: { intent: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button> & {
    children: ReactNode;
    /**
     * Shows a spinner and disables the button.
     *
     * Separate from `disabled` because they mean different things to a user: disabled is
     * "you cannot do this", busy is "it is happening". Conflating them is how an interface
     * ends up looking broken while it works.
     */
    busy?: boolean;
  };

export function Button({ intent, size, busy = false, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || busy}
      // Announced to assistive tech, because a visual spinner says nothing to a screen
      // reader - without this the button simply goes quiet and unresponsive.
      aria-busy={busy || undefined}
      className={clsx(button({ intent, size }), className)}
    >
      {busy ? <Spinner /> : undefined}
      {children}
    </button>
  );
}

/**
 * The spinner.
 *
 * Fast - 600ms per rotation rather than the common 1s. A faster spinner makes the app feel
 * like it loads quicker even when the load time is identical, and perceived speed is worth
 * as much here as real speed.
 *
 * `animate-spin` is a transform animation, so it runs on the compositor and keeps spinning
 * smoothly even while the main thread is busy parsing the response it is waiting for -
 * which is precisely when a main-thread animation would stutter and make the app look
 * slower than it is.
 */
function Spinner() {
  return (
    <svg
      className="size-4 animate-spin [animation-duration:600ms]"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
