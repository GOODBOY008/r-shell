# Password View Toggle Design

## Context

The connection dialog has three password-style fields, all plain `<Input type="password">` elements in `src/components/connection-dialog.tsx`:

- Password field (`connection-dialog.tsx:795`)
- SSH passphrase field (`connection-dialog.tsx:821`)
- Proxy password field (`connection-dialog.tsx:942`)

None of them offer a way to reveal what was typed, and there is no shared password input component in `src/components/ui/`. The shared `Input` component (`src/components/ui/input.tsx`) only forwards the `type` prop.

## Goal

Give every password field a **view/hide password** toggle so users can verify what they typed before connecting. Introduce one reusable `PasswordInput` component so all three fields share the same behavior and styling.

## Design

### New component: `src/components/ui/password-input.tsx`

A small wrapper around the existing `Input` that adds a show/hide control:

- Maintains internal `show` state (defaults to `false`, i.e. hidden).
- Renders a `relative` wrapper containing the `Input` and an absolutely-positioned icon button on the right (`Eye` when hidden, `EyeOff` when shown).
- Toggles the inner input's `type` between `"password"` and `"text"` based on `show`.
- Adds right padding (`pr-10`) to the input so typed text does not run under the button.
- The button carries an accessible `aria-label`/`title` reflecting the next action — `"Show password"` when hidden, `"Hide password"` when shown. These labels are hardcoded English in the presentational component (consistent with the other `ui/*` components being i18n-free); the connection dialog's surrounding labels already come from `t()`.
- Spreads all remaining props (`id`, `value`, `onChange`, `placeholder`, `className`, …) through to the inner `Input`, so labels (`htmlFor`/`id`), controlled state, and tests keep working unchanged.

```tsx
// Illustrative — not final implementation.
function PasswordInput({ className, ...props }: React.ComponentProps<"input">) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? "text" : "password"} className={cn("pr-10", className)} {...props} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
```

### Swap the three fields

Replace `<Input type="password" …>` with `<PasswordInput …>` in the three locations listed above, keeping each field's `id`, `placeholder`, `value`, and `onChange`.

## Accessibility

- The toggle is a real `<button type="button">`, so it does not submit forms and is keyboard-reachable.
- It announces its purpose via `aria-label`/`title`, which flips with the current state ("Show"/"Hide").
- The inner input remains associated with its `Label` through the unchanged `htmlFor`/`id`.

## Error Handling

No new error path. The toggle is purely presentational and never touches config state; a failed or partial render of the button simply leaves the field showing dots, the current default.

## Testing

- Add a focused unit test for `PasswordInput` in `src/__tests__/password-input.test.tsx` (render, toggle `type` between `password`/`text`, `aria-label` flips).
- Run the existing `connection-dialog*.test.tsx` suites; they query password fields by `getByLabelText('Password')` via the label association, which the wrapper preserves.
- Run the project type-check and the full `npm test` suite.

## Scope

Limited to the connection dialog's three password fields. No changes to auth logic, config storage, or any non-password inputs. If other password fields appear later, they adopt `PasswordInput` in place of `<Input type="password">`.
