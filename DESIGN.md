# Pagent Design System

## 1. Atmosphere & Identity

Pagent feels like a quiet editorial workspace: warm paper, precise typography, and compact operational detail without visual noise. The signature is the pairing of Instrument Serif for human-facing titles with JetBrains Mono for identity, access, and analytics facts. Product screens preserve the existing landing page's warm bone canvas and rust accent while using crisp, low-elevation work surfaces.

## 2. Color

### Palette

| Role            | Token                  | Light                    | Dark                  | Usage                               |
| --------------- | ---------------------- | ------------------------ | --------------------- | ----------------------------------- |
| Canvas          | `--pg-canvas`          | `#f4ede1`                | `#15140f`             | Page and shell background           |
| Surface         | `--pg-surface`         | `#fffdf8`                | `#201e18`             | Cards, tables, dialogs              |
| Surface subtle  | `--pg-surface-subtle`  | `#ebe2d2`                | `#29261f`             | Secondary panels, hover rows        |
| Ink             | `--pg-ink`             | `#15140f`                | `#f4ede1`             | Primary text                        |
| Ink secondary   | `--pg-ink-secondary`   | `#6e685c`                | `#c8bead`             | Supporting copy and metadata        |
| Rule            | `--pg-rule`            | `#d8cdb9`                | `#474137`             | Borders and separators              |
| Accent          | `--pg-accent`          | `#c8472f`                | `#e36b52`             | Primary actions and focus           |
| Accent strong   | `--pg-accent-strong`   | `#9f3524`                | `#f28770`             | Hover and active states             |
| Success surface | `--pg-success-surface` | `#edf3ec`                | `#1d2b1f`             | Successful and active states        |
| Success ink     | `--pg-success-ink`     | `#346538`                | `#a7d2a7`             | Success labels                      |
| Warning surface | `--pg-warning-surface` | `#fbf3db`                | `#302817`             | Warnings and Unverified labels      |
| Warning ink     | `--pg-warning-ink`     | `#7d5700`                | `#f1cf79`             | Warning text                        |
| Error surface   | `--pg-error-surface`   | `#fdebec`                | `#351b1c`             | Denied, revoked, destructive states |
| Error ink       | `--pg-error-ink`       | `#8f2c2a`                | `#f2a4a1`             | Error text                          |
| Info surface    | `--pg-info-surface`    | `#e1f3fe`                | `#172833`             | Informational states                |
| Info ink        | `--pg-info-ink`        | `#1f628c`                | `#9ed3f1`             | Informational text                  |
| Focus           | `--pg-focus`           | `#7b2f20`                | `#f28770`             | Keyboard focus outline              |
| Backdrop        | `--pg-backdrop`        | `rgba(21, 20, 15, 0.45)` | `rgba(0, 0, 0, 0.72)` | Dialog scrim                        |
| Slide stage     | `--pg-slide-stage`     | `#d8cdb9`                | `#d8cdb9`             | Neutral preview surround            |
| Slide surface   | `--pg-slide-surface`   | `#ffffff`                | `#ffffff`             | Authored slide canvas               |
| Slide ink       | `--pg-slide-ink`       | `#15140f`                | `#15140f`             | Authored slide text                 |
| Presentation    | `--pg-presentation`    | `#090906`                | `#090906`             | Fullscreen viewer surround          |

### Rules

- Accent color is reserved for actions, links, selection, and focus.
- Identity-confidence states always pair color with explicit text: Anonymous, Unverified, or Authenticated.
- Error, warning, and success surfaces must retain 4.5:1 text contrast.
- New colors are added here before use.

### Landing semantic aliases

The landing page consumes the core `--pg-*` palette, font, and spacing tokens directly. Its
editorial hero and dark install/terminal specimens add only the following `--pg-home-*` aliases;
they are intentionally local to `<home-page>` and must not become a second product palette.
Opacity variants derive from colocated `*-rgb` channel tokens rather than introducing more colors.
Each companion mirrors its source color for `rgba(var(...), alpha)`; the highlight is alpha-only.

| Role               | Tokens                                                                                                                                                                                                  | Contract                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Editorial neutrals | `--pg-home-highlight-rgb` (`255, 255, 255`), `--pg-home-copy` (`#3a352d`)                                                                                                                               | Alpha-only paper highlights and long-form hero copy                                             |
| Terminal states    | `--pg-home-terminal-label` (`#b4ac9b`), `--pg-home-terminal-muted` (`#8c8478`), `--pg-home-terminal-success` (`#9bc78a`), `--pg-home-terminal-copied` (`#b6dca5`), `--pg-home-terminal-url` (`#f6c89f`) | Legible syntax and state colors on the dark install specimens; never used as product status ink |
| Editorial type     | `--pg-home-type-terminal`, `--pg-home-type-lede`, `--pg-home-type-display`                                                                                                                              | Shared terminal sizing and the landing's high-contrast serif hero scale                         |
| Editorial radii    | `--pg-home-radius-action`, `--pg-home-radius-panel`                                                                                                                                                     | Reused action/terminal and install-panel geometry                                               |
| Editorial depth    | `--pg-home-shadow-pulse`, `--pg-home-shadow-pulse-wide`, `--pg-home-shadow-status`, `--pg-home-shadow-panel`, `--pg-home-shadow-terminal`                                                               | The only landing shadow recipes; all are derived from core colors                               |

## 3. Typography

### Scale

| Level      | Size                         | Weight | Line height | Tracking   | Usage                                |
| ---------- | ---------------------------- | ------ | ----------- | ---------- | ------------------------------------ |
| Display    | `clamp(2.5rem, 6vw, 4.5rem)` | 400    | 1           | `-0.02em`  | Marketing and empty-state statements |
| H1         | `2.25rem`                    | 400    | 1.12        | `-0.018em` | Product page title                   |
| H2         | `1.5rem`                     | 600    | 1.25        | `-0.01em`  | Major section heading                |
| H3         | `1.125rem`                   | 600    | 1.35        | `0`        | Card and dialog heading              |
| Body large | `1.125rem`                   | 400    | 1.6         | `0`        | Lead copy                            |
| Body       | `1rem`                       | 400    | 1.55        | `0`        | Default copy and controls            |
| Body small | `0.875rem`                   | 400    | 1.5         | `0`        | Secondary information                |
| Caption    | `0.75rem`                    | 500    | 1.4         | `0.02em`   | Labels and metadata                  |
| Overline   | `0.6875rem`                  | 600    | 1.35        | `0.1em`    | Uppercase section labels             |

### Font Stack

- UI and body (`--pg-font-ui`): `Outfit, system-ui, -apple-system, sans-serif`.
- Display serif (`--pg-font-display`): `Instrument Serif, Georgia, Times New Roman, serif`.
- Metadata and code (`--pg-font-metadata`): `JetBrains Mono, ui-monospace, monospace`.

### Rules

- Body copy is never smaller than 14px.
- Tabular values use `font-variant-numeric: tabular-nums`.
- Long email addresses and tokens use `overflow-wrap: anywhere`.

## 4. Spacing & Layout

### Base Unit

Structural spacing derives from 4px and uses `--pg-space-*`. Isolated landing-page optical values
may remain literal when they do not represent a reusable spacing decision.

| Token           | Value  | Usage                         |
| --------------- | ------ | ----------------------------- |
| `--pg-space-1`  | `4px`  | Tight inline separation       |
| `--pg-space-2`  | `8px`  | Icon and label, compact rows  |
| `--pg-space-3`  | `12px` | Control gap and input padding |
| `--pg-space-4`  | `16px` | Standard content padding      |
| `--pg-space-5`  | `20px` | Dense card padding            |
| `--pg-space-6`  | `24px` | Default card padding          |
| `--pg-space-8`  | `32px` | Section groups                |
| `--pg-space-10` | `40px` | Page sections                 |
| `--pg-space-12` | `48px` | Major breaks                  |
| `--pg-space-16` | `64px` | Page-level breathing room     |

### Grid

- Product shell max width: 1440px; readable content max width: 72ch.
- Desktop: 240px navigation rail plus fluid content; tablet and mobile: a single document-scrolling column.
- Metric grids use `repeat(auto-fit, minmax(min(15rem, 100%), 1fr))`.
- Breakpoints: narrow 640px, mid 900px, wide 1200px.
- Product pages own document scrolling. Fullscreen viewer owns a bounded `100dvh` presentation shell with fixed controls and a `min-block-size: 0` slide viewport.

## 5. Components

### Product shell

- **Structure**: skip link, landmark header, navigation, main content, optional contextual actions.
- **Variants**: page library, detail, workspace admin, fullscreen viewer.
- **Spacing**: `--pg-space-4` through `--pg-space-8`.
- **States**: narrow navigation, authenticated user, loading, unauthenticated redirect.
- **Accessibility**: one `main`, visible skip link, current page marked with `aria-current`.
- **Motion**: no decorative shell motion.
- **Layout**: fixed-sidenav shell above 900px; document scroll below it.

### Button and link action

- **Structure**: native `button` or anchor with text and optional SVG.
- **Variants**: primary, secondary, quiet, destructive.
- **Spacing**: `--pg-space-2` and `--pg-space-3`; 44px minimum touch target.
- **States**: default, hover, active, focus-visible, disabled, loading.
- **Accessibility**: native semantics; loading retains an accessible name and uses `aria-busy`.
- **Motion**: 120ms transform/opacity feedback; none under reduced motion.
- **Layout**: cluster.

### Field and choice group

- **Structure**: label, input/select/textarea/radio group, hint, inline error.
- **Variants**: text, email, date/time, select, checkbox, radio cards.
- **Spacing**: `--pg-space-2` and `--pg-space-3`.
- **States**: default, hover, focus, disabled, error, valid.
- **Accessibility**: explicit labels, `aria-describedby`, fieldset/legend for grouped choices.
- **Motion**: focus and validation use color/opacity only.
- **Layout**: stack.

### Status badge

- **Structure**: short text label; optional decorative SVG.
- **Variants**: neutral, active, expired, revoked, Anonymous, Unverified, Authenticated.
- **Spacing**: `--pg-space-1` and `--pg-space-2`.
- **States**: static; never color-only.
- **Accessibility**: full status word is present in text.
- **Motion**: none.
- **Layout**: cluster.

### Surface card and metric card

- **Structure**: heading, value/content, optional footer action.
- **Variants**: standard, metric, warning, empty.
- **Spacing**: `--pg-space-5` or `--pg-space-6`.
- **States**: rest, linked hover/focus, loading skeleton, empty, error.
- **Accessibility**: linked cards expose one primary action and avoid nested controls.
- **Motion**: linked cards use 150ms border/transform feedback.
- **Layout**: stack inside an intrinsic grid.

### Data table and responsive record list

- **Structure**: caption, headers, rows, row actions; narrow view becomes labeled records.
- **Variants**: page library, visitors, slides, links, audit log, admin metadata.
- **Spacing**: `--pg-space-3` and `--pg-space-4`.
- **States**: loading, empty, filtered-empty, error, selected row.
- **Accessibility**: semantic table on wide screens; labels remain programmatically associated in narrow records.
- **Motion**: none beyond focus/selection feedback.
- **Layout**: table scroll is permitted only for secondary columns; primary content reflows.

### Tabs

- **Structure**: tablist, tabs, one active panel.
- **Variants**: presentation page Overview, Visitors, Slides, Share links, Access & settings.
- **Spacing**: `--pg-space-3` and `--pg-space-4`.
- **States**: default, hover, focus, selected, disabled.
- **Accessibility**: arrow-key navigation, Home/End, `aria-controls`, URL-addressable selection.
- **Motion**: 150ms opacity transition, disabled under reduced motion.
- **Layout**: horizontally scrollable reel on narrow screens with visible focus.

### Dialog and confirmation

- **Structure**: native dialog, title, explanatory copy, form/body, cancel and confirm actions.
- **Variants**: share-link editor, access decision, delete confirmation, analytics audience preview.
- **Spacing**: `--pg-space-4` through `--pg-space-6`.
- **States**: opening, ready, submitting, error, success.
- **Accessibility**: focus trap, Escape closes non-destructive dialogs, return focus to trigger, destructive confirmation names the page.
- **Motion**: 200ms opacity/transform; reduced motion uses immediate state.
- **Layout**: imposter over backdrop, max inline size constrained to viewport.

### Access gate

- **Structure**: presentation page and sender identity, privacy and tracking notice, access control, help/request action.
- **Variants**: Allowed email, Authenticated viewer, pending, denied, expired, revoked.
- **Spacing**: `--pg-space-4` through `--pg-space-8`.
- **States**: idle, submitting, mismatch, request pending, authentication required, unavailable.
- **Accessibility**: clear heading, persistent explanation, generic non-enumerating errors, focus moved to outcome.
- **Motion**: state change uses 200ms opacity only.
- **Layout**: cover with readable content limiter.

### Authentication page

- **Structure**: Pagent overline, one clear heading, optional error notice, provider action, or email field; completion states reuse the same surface and hierarchy.
- **Variants**: email-only, Google plus email, OAuth consent continuation, check-email confirmation, and recoverable error.
- **Spacing**: `--pg-space-2` through `--pg-space-8` inside a 400–440px readable surface.
- **States**: ready, provider unavailable, submitted, invalid input, rate-limited, and service unavailable.
- **Accessibility**: explicit email label, 44px controls, visible focus, status/alert roles, no provider button when its configuration is incomplete.
- **Motion**: button press feedback only; removed under reduced motion.
- **Layout**: centered document-scrolling surface on the warm canvas at mobile, tablet, and desktop widths.

### Presentation frame and controls

- **Structure**: presentation page identity, slide viewport, previous/next, current count, fullscreen, optional filmstrip.
- **Variants**: owner preview and tracked viewer.
- **Spacing**: `--pg-space-2` through `--pg-space-4`.
- **States**: loading, ready, first/last slide, fullscreen, offline tracking queue.
- **Accessibility**: arrow keys, PageUp/PageDown, Home/End, touch buttons, announced slide number, 44px targets.
- **Motion**: slide changes use 180ms opacity/transform and an immediate reduced-motion alternative.
- **Layout**: bounded `100dvh` scroll-body shell; the slide viewport is the only flexible region.

### Chart and engagement timeline

- **Structure**: text summary, SVG visualization, data table alternative.
- **Variants**: visits, slide active time, drop-off distribution, visit sequence.
- **Spacing**: `--pg-space-3` through `--pg-space-6`.
- **States**: loading, empty/low data, populated, error.
- **Accessibility**: visible units, no color-only series, descriptive summary, table fallback.
- **Motion**: none required; data updates use polite announcements.
- **Layout**: frame within a surface card.

### Workspace admin

- **Structure**: workspace identity, member and role summary, presentation page metadata, retention/consent policy, audit activity.
- **Variants**: overview, members, governance, audit log.
- **States**: loading, empty, filtered-empty, partial permission, error.
- **Accessibility**: governance actions state their scope and consequence; metadata-only access never implies content or viewer-analytics access.
- **Motion**: none beyond standard dialog and focus feedback.
- **Layout**: product shell with compact tables that become labeled records on narrow screens.

## 6. Motion & Interaction

| Type     | Duration | Easing                        | Usage                                |
| -------- | -------- | ----------------------------- | ------------------------------------ |
| Micro    | 120ms    | ease-out                      | Press and focus feedback             |
| Standard | 200ms    | ease-in-out                   | Dialog and tab state change          |
| Emphasis | 480ms    | cubic-bezier(0.16, 1, 0.3, 1) | First meaningful product reveal only |

### Interaction pattern sources

- **Buttons:** adapted from beui.dev `button/base` and `button/stateful`. Native buttons use interruptible `:active` scale feedback (`0.98`) and keep idle/loading/success/error labels in one live region. The project has no spring runtime, so the 120ms CSS micro token is used instead of adding Motion; reduced motion removes the transform.
- **Tabs:** adapted from beui.dev `tabs`. Panels stay mounted and inactive panels use `hidden`; arrow keys, Home, and End move selection. The active state uses color and a short opacity reveal rather than a shared-layout spring because the design contract favors restrained motion and the project has no shared-layout runtime.
- **Dialogs:** adapted from beui.dev `center-morph-modal`. Native `<dialog>` supplies modality and focus containment; the panel enters with a small opacity/scale change, Escape closes non-destructive flows, and focus returns to the invoking control. The project contract excludes clip-path motion, so the source's center unfold becomes the Standard opacity/transform token.

- Animate only transform and opacity.
- Motion always communicates a real state or spatial relationship.
- `prefers-reduced-motion: reduce` disables non-essential transitions and makes slide changes immediate.
- Keyboard, pointer, and touch yield the same state and feedback.

## 7. Depth & Surface

The strategy is borders-first with very restrained shadows for dialogs only.

| Level         | Token/value                                | Usage                             |
| ------------- | ------------------------------------------ | --------------------------------- |
| Default rule  | `1px solid var(--pg-rule)`                 | Cards, inputs, tables, separators |
| Surface inset | `0 1px 0 rgba(255, 255, 255, 0.45) inset`  | Dark share/action surfaces only   |
| Dialog        | `0 24px 70px -36px rgba(21, 20, 15, 0.55)` | Modal elevation over backdrop     |

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA minimum: 4.5:1 body contrast, 3:1 large text and control boundaries.
- Every flow is operable by keyboard at 200% zoom and at 375px width.
- Identity confidence, link status, and analytics states are expressed in words, not color alone.
- Access errors remain generic enough to avoid audience enumeration while still explaining the next action.
- Viewer tracking never blocks navigation and analytics consent is disclosed before the presentation page opens.
- Charts always have an equivalent textual/table representation.
- Focus is visible and restored after dialogs; validation is announced without clearing user input.

### Accepted Debt

No accepted design or accessibility debt for v0.1.0.
