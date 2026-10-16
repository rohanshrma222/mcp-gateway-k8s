/**
 * A modal dialog, on the native `<dialog>` element.
 *
 * **Why not a UI primitives library.** The curated pick for dialogs is base-ui, and the
 * warning it exists to prevent is real: a `<div>`-based dialog with hand-rolled focus
 * handling is a genuine accessibility failure. But a native `<dialog>` opened with
 * `showModal()` is not that. The browser gives focus trapping, Escape-to-close, an inert
 * background, the top layer (so no z-index fights) and `::backdrop` - the exact list the
 * library is recommended for. Two further reasons settled it: base-ui is at `1.0.0-rc.0`
 * and this would have been the only release-candidate dependency in the project, and this
 * app needs a dialog in two places. The library earns its place when there are selects,
 * menus, popovers and comboboxes to be consistent across; that is a real possibility later
 * and this file is ~80 lines to replace.
 *
 * What the native element does NOT give for free is the animation, because an element in
 * the top layer is display:none until it is open - so there is nothing to transition from.
 * `@starting-style` plus `transition-behavior: allow-discrete` is what makes that work, and
 * it is in index.css rather than here.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /**
   * Optional, and typed as `string | undefined` rather than just optional.
   *
   * Under `exactOptionalPropertyTypes` those are different: a plain `description?: string`
   * rejects an explicitly-passed undefined, which is exactly what a caller writing
   * `description={done ? undefined : "..."}` produces. Two call sites do that, and the
   * alternative is a conditional spread at each one - noise to satisfy a distinction that
   * does not matter here, because an absent description and an undefined one render the
   * same.
   */
  description?: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    /**
     * `showModal()`, never `show()` or the `open` attribute.
     *
     * Only `showModal` puts the element in the top layer and makes the rest of the page
     * inert. Setting `open` directly renders a dialog that looks identical and traps
     * nothing - the user can tab into the form behind it, which is the failure mode this
     * component exists to avoid.
     */
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    // The browser closes on Escape by itself, which would leave React thinking it is still
    // open. `close` fires for every route - Escape, the close button, `close()` - so this
    // is the single place the two are reconciled.
    const onNativeClose = () => onClose();
    element.addEventListener('close', onNativeClose);
    return () => element.removeEventListener('close', onNativeClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      {...(description === undefined ? {} : { 'aria-describedby': 'dialog-description' })}
      /**
       * A click on the backdrop closes it.
       *
       * The backdrop is not a separate element - it is the dialog's own `::backdrop`
       * pseudo-element - so a click on it targets the dialog itself. Comparing the target
       * to the element is how that is distinguished from a click on the content, which
       * bubbles up from a child. Without the check, clicking any text inside the form
       * would close the dialog mid-edit.
       */
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="dialog-panel"
    >
      {/* An inner element, so the click check above works: everything the user can click is
          a descendant, and only the backdrop is the dialog itself. */}
      <div className="w-[min(32rem,calc(100vw-2rem))] p-5">
        <h2 id="dialog-title" className="text-base font-semibold tracking-tight text-ink-50">
          {title}
        </h2>
        {description === undefined ? undefined : (
          <p id="dialog-description" className="mt-1 text-sm text-ink-400">
            {description}
          </p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  );
}
