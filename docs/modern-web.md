# Modern web practices and cross-browser verification

[Back to the README](../README.md)


The UI was audited with Google Chrome's [Modern Web Guidance](https://www.npmjs.com/package/modern-web-guidance)
(version 1.0.1): its `legacy-scan` for the patterns it can detect, and its guides read against the code for the
rest. The tool is not a dependency of the project. A feature was adopted where the guides call it Baseline
widely available, or where the older behaviour stays as the fallback. What changed:

- **Dialogs** (`dialog`, `light-dismiss-a-dialog`, `platform-controls-dismiss-dialog`,
  `prevent-page-scroll-under-modal-dialog`). Every modal, the screenshot lightbox included, is a native
  `<dialog>` opened with `showModal()`: the browser provides the top layer, the inert page, focus containment,
  Escape and back-gesture dismissal and the return of focus, replacing a hand-written focus trap. Clicking
  outside uses `closedby="any"`, with a pointer fallback where that attribute is missing (Safari). A
  confirmation focuses *Cancel*. The element inspector is a non-modal `<dialog>`.
- **Input methods** (`ime-safe-enter-submit`). Every Enter and Escape handler on a text field (assistant
  message, inline rename, command search, element name, locator fields) ignores the keystroke that confirms or
  cancels a Chinese, Japanese or Korean conversion, including Safari's `keyCode` 229 case.
- **Messages** (`persistent-toast-notifications`). A toast outside a modal dialog is inert, so while a dialog
  is open its messages are shown inside it; the toast area is a named region.
- **Motion** (`motion`, `spinner`). No global "kill all animation" rule: under `prefers-reduced-motion`
  panels fade instead of rising, the element pulse is left out and spinners turn slowly.
- **Keyboard and assistive technology** (`accessibility`, `tabs`, `drag-and-drop`, `breadcrumbs`,
  `copy-button`). Tabs have one tab stop, arrow keys and a labelled tab panel; steps can be reordered from the
  step menu (*Move up* / *Move down*) with the move announced, not only by dragging; breadcrumbs are an
  ordered list; the copy button reports a failed copy; focus rings and the selected tab stay visible in
  forced-colours mode.
- **Forms** (`forms`, `autofill-sign-in-form`). The access code field is a labelled, required
  `current-password` field a password manager can fill; URL and identifier fields turn off autocorrect and
  set `enterkeyhint`.
- **Typography and images** (`typography`, `html`). Font sizes are in `rem`, so the browser's font-size
  setting applies; the captured screenshot and the sample site's images carry their dimensions.
- **JavaScript** (`js`). `toSorted()` / `findLast()` instead of copy-then-mutate, and `Error` `cause` in the
  seed script.

A second pass went through seventeen more guides, one by one:

- **`performance`** - applied. The editor, the result page and the batch page are loaded on demand
  (`React.lazy`), so the project list and the access form no longer download them; a tab left open across a
  deployment reloads once when a lazily loaded file is gone; the hashed files under `/assets` are served as
  `immutable` (they pass through the Worker, which answers a hashed file that does not exist with a 404
  instead of the app shell, so the shell is never cached under a script's address). The two IBM Plex families are
  self-hosted (`public/fonts/v1`, latin subset, SIL Open Font License): no third-party connection, the two weights of
  the first paint are preloaded, and the files are cached as immutable.
- **`security`** - applied. Every response carries `X-Frame-Options: DENY`, `nosniff`, a `Referrer-Policy`, a
  `Permissions-Policy`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` (`public/_headers` for
  the static app shell, `worker/security.ts` for `/api` and `/demo`). The app has an enforced
  Content-Security-Policy with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'` and Trusted
  Types; the sample site, whose pages contain inline scripts, gets the three framing and plugin directives
  only. The access cookie is `__Host-sw_access` over https. `/api` refuses requests another site makes the
  browser send (`Sec-Fetch-Site`), before the access code is checked. `Strict-Transport-Security` starts at
  `max-age=300`: raise it to a year once it has been live without trouble. Not done: `script-src` is `'self'` (plus the Cloudflare Web Analytics beacon the zone injects)
  rather than hashes with `'strict-dynamic'` (the shell is static and its only script is the hashed bundle),
  and there is no violation report endpoint, because nothing collects reports.
- **`browser-ui-theming`** - applied. Placeholder and muted text reach 4.5:1 in the light theme, text fields
  have an outline of 3:1 against their surface in both themes (`--control-line`), and the assistant's message
  box grows with its text (`field-sizing`), or can be dragged taller where that is not supported.
- **`css-layout`** - applied. Clipping uses `overflow: clip`; nested scroll areas contain their overscroll;
  lists that grow reserve their scrollbar gutter; widths that meant "the viewport" no longer use `100vw`;
  direction-related margins, paddings, borders and alignments are logical properties (offsets that script
  sets from physical coordinates, such as the inspector's side, stay physical); chip rows use
  `flex-wrap: balance` where it exists.
- **`responsive-design`** - applied. Heights limited by the viewport use `dvh`; the page sections and the
  self-healing dialog switch layout by the width of their container (`@container`), not of the window. Fluid
  type is not used, so the `clamp()` rules do not apply.
- **`form-factor-adaptation`** - applied. Controls are at least 24 by 24 pixels, and 44 on touch screens
  (`pointer: coarse`), checkboxes through the label around them (the panel divider and the element outlines
  on a screenshot excepted; the sample site's choices and menu button follow the same sizes); bars, chips and headers have minimum
  heights instead of fixed ones; the page header, title row and dialog footer wrap; a 320px page no longer
  scrolls sideways (variable rows, long words); headings use `text-wrap: balance`, paragraphs `pretty`.
- **`responsive-table`** - applied. A table's scroll container is a focusable, named region; the cell that
  names a row is a row header; in a narrow container a list table stacks into labelled blocks instead of
  squeezing its name column to nothing. Not done: sticky headers, which would turn every list into its own
  vertical scroll area inside the page. Deferred: the same region wrapper around the sample site's table,
  because a focusable wrapper is detected as a clickable element when that page is captured.
- **`single-line-overflow`** - applied. The tab strip draws its focus ring inside the tab instead of having
  it clipped; step sentences on the test case page and in the screenshot viewer wrap, and the screen list
  shows a captured address in full, so no text is readable only through a hover `title`; a validation
  message no longer cuts the value in script. Kept: the name column truncates through `max-width: 0` rather
  than `table-layout: fixed`, which would need a fixed width for every date and device column.
- **`icons`** - applied. The one informative icon without a role has `role="img"`, and the grey of the
  "aborted / skipped / queued" icons is 3:1 on hovered and selected rows too. Icons are inline SVG in
  `currentColor`; the guide's CSS icon system is not needed.
- **`navbar`** - applied to the sample site (the app has breadcrumbs, not a navigation bar). The current
  page is marked with `aria-current` and underlined; on a phone the navigation is a native popover where the
  Popover API exists (Escape and a tap outside close it), and the class toggle it replaces, now with Escape
  and outside-press handling, remains the fallback. Deferred: collapsing by measuring whether the links fit
  instead of at a fixed width. The layout of a test target would then be decided by script after load, and
  a capture taken right then could see either state.
- **`toolbar`** - applied. Toggle buttons keep one name and report their state through `aria-pressed`, which
  their pressed look (now with a 3:1 outline, also in forced colours) is styled from; unavailable icon
  buttons are `aria-disabled` and stay focusable, so focus is not lost when Undo runs out; menu buttons
  report `aria-expanded`; Undo and Redo are announced; hover styles of these buttons apply only where
  hovering exists. The view buttons and Capture are a named group; they are not a `role="toolbar"` with one
  tab stop, which the guide requires only of something declared a toolbar.
- **`natural-interactions`** - applied. Buttons, chips, menu items and links have a pressed state; a menu's
  keyboard focus is a ring, no longer the hover tint (and a menu now takes focus when it opens); the focus
  ring of a text field is a 2px accent line; popovers grow out of the corner that touches their trigger;
  the tab strip snaps; what appeared only on hover (a step's menu and grip, an element's name tip) also
  appears on keyboard focus and on touch screens; element outlines on a screenshot are reachable by
  keyboard (one tab stop, arrow keys, Enter to pick, Shift+Enter to inspect); a step in the run log opens
  its screenshot from the keyboard.
- **`interest-triggered-tooltips`** - applied. The assistant's token breakdown is a toggletip behind a
  visible button instead of a `title` on plain text; Escape hides the element name tips without moving the
  pointer. `interestfor` and `popover="hint"` are not used: neither is in every browser yet.
- **`animate-to-from-top-layer`** - applied. The dimming behind a dialog fades in with it, and the
  screenshot viewer fades in. Dialogs still close without an animation; the guide describes how to animate
  an exit but does not ask for one.
- **`accessible-error-announcement`** - applied. The access code field turns red and `aria-invalid` at the
  same moment (`:user-invalid`), and a rejected code puts focus back on the field, which reads the error; a
  project variable with a bad name is marked and points at its message, announced once typing pauses; the
  sample site's two forms mark the field at fault and move focus to it.
- **`scroll-target-on-load`** - not applicable. Nothing in the app is positioned once on load; the places
  that scroll to something (the selected step, the step's element, the end of the conversation) do so again
  on every change, which needs script. `scroll-initial-target` is also Chromium-only.
- **`navigation-drawer`** - not applicable. Neither the app nor the sample site has a drawer; the assistant
  panel is a non-modal tool panel, and the sample site's phone navigation opens under its header (see
  `navbar`).

Left as they are, on purpose: menus and popovers are positioned in script, because CSS anchor positioning is
not in Firefox yet and the Popover API is not yet Baseline widely available (the sample site's phone
navigation uses it as an enhancement over a script fallback); the light and dark themes use
`prefers-color-scheme` with `color-scheme` (the guides' own fallback for `light-dark()`); controls keep their
compact pixel heights for a mouse (the 44px minimum applies to touch screens); and `title` attributes remain
as hover hints on controls that already have an accessible name.

### Cross-browser verification

The app and the sample site were exercised with the browser builds of Playwright 1.65.1, headless on macOS:
Chromium 159.0.8154.6, WebKit 27.2 (the stand-in for Safari) and Firefox 159.0, against both the production
build served by the local Worker and the in-browser mock API. Real Safari, iOS and platforms with classic
(non-overlay) scrollbars were not tested. What differs per engine, and what the code does about it:

- **Scrolling under a modal dialog.** `overscroll-behavior: contain` on the dialog and its backdrop keeps
  the page still in Chromium only; WebKit and Firefox pass the wheel on to the document. The document
  therefore does not scroll while a modal dialog is open (`html:has(dialog:modal)`), with the scrollbar
  gutter of the scrolling pages reserved so they do not shift. The page keeps its position in all three.
- **Focus ring of a checkbox.** WebKit paints no box shadow on a native checkbox or radio button, so their
  ring is an outline, in every engine.
- **Date field (sample site).** In WebKit the segments inside the field take focus: the field never matches
  `:focus-visible` and `focus()` does not scroll it into view. The field gets the ring of the other fields
  through `:focus-within`, and a failed submit scrolls the message and the field into view itself.
- **`form.elements` by name (sample site).** Firefox drops a control from the named lookup once an id equal
  to its name is changed, which stopped the redesigned reservation form (`?ui=v2`) from working there. The
  controls are now looked up once with `querySelector`.
- **Leaving while a route is still loading.** Firefox and WebKit fail a dynamic import that a navigation
  interrupts, Chromium does not; the reload for a file that is gone after a deployment used to cancel that
  navigation. It is skipped while the page is leaving, and still happens when the file is really missing.
- **Focus after a dialog opened with the mouse.** Safari on macOS does not focus a button that is clicked,
  so a dialog had no invoker to hand focus back to. The control last pressed is remembered and focused when
  focus would otherwise end on `<body>`; the sample site's phone menu does the same.
- **Text fields on a touch screen.** iOS zooms the page when a field with text under 16px takes focus, so
  fields are at least 16px where the pointer is coarse (set from the media query; not tried on a device).
- **`flex-wrap: balance`.** Chromium only. The eight command categories wrap 4 + 4 there and 7 + 1 in WebKit
  and Firefox; this is the plain `wrap` fallback and is left as it is.
- **Console only.** WebKit logs a warning that the page is not cross-origin isolated on a full-page
  navigation (the `Cross-Origin-Opener-Policy` value is intended; nothing needs isolation). Behind the Vite
  development and preview servers, which add `Vary: Origin`, WebKit downloads the two preloaded fonts twice;
  with that header removed by a proxy it downloads them once. The deployed site's headers were not checked.

The same pass fixed seven things that behaved alike in all three engines: a click on the description while the name was being edited was lost, because the name's field took the whole line and moved what was below it; the lightbox let the page header show through its bar; on a phone the *Copy* button covered the first line of the CI command and variable names were cut; keyboard focus was lost after
*Move up* / *Move down* and after an inline rename confirmed with Enter or Escape; the "needs review" banner
squeezed its text into a narrow column on a phone; the access code field stayed marked invalid for one
keystroke after the "only spaces" message; and the sample site's *My stays* link was not marked as the
current page when the address had no `.html`.
