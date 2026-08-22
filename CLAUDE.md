# CLAUDE.md

VRChat Group Notify Scheduler — a **Manifest V3 Chrome extension** built with
Next.js (static export). The popup/full-page UI lives in `pages/index.jsx`
(+ `styles/*.module.css`); the background service worker and APIs live under
`public/background/` (`background.js`, `api.js`, `scheduler.js`).

## Building the extension — READ THIS FIRST

Next.js (`output: 'export'`) emits everything under **`out/_next/`**. Chrome
rejects any path segment starting with `_`, so a raw `next build` produces an
`out/` that fails to load with:

> Cannot load extension with file or directory name _next. Filenames starting
> with "_" are reserved for use by the system. Could not load manifest.

`fix-extension.js` renames `out/_next` → `out/assets`, rewrites all references
to relative `./assets/...` paths, and then **verifies** the result.

### Rules

- ✅ **ALWAYS build with `npm run build`** — it runs `next build && node fix-extension.js`.
- ❌ **NEVER run `next build` / `npx next build` on its own** — it re-creates
  `out/_next` and leaves an unloadable `out/`. (This is the #1 recurring failure.)
- 🔧 **Recovery:** if `out/` is already broken (e.g. someone ran `next build`
  directly), run `npm run verify` (alias for `node fix-extension.js`) to repair
  and re-validate in place — no full rebuild needed.

`npm run build` / `npm run verify` end with `✅ out/ is extension-ready` on
success, and **exit non-zero** if any `_`-prefixed path or a missing
`manifest.json` / `index.html` is detected. Trust that signal.

### Load / test in Chrome

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
the `out/` directory. VRChat group fetching requires being logged into VRChat
in the same browser profile.

## Notes

- `out/`, `.next/`, and `node_modules/` are gitignored — never commit build output.
- Design tokens are defined as CSS custom properties on `:root` inside the
  injected `<style>` block in `pages/index.jsx`; the `*.module.css` classes
  reference them via `var(--token)`.
