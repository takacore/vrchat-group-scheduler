---
name: build-extension
description: Safely build this Next.js → Chrome (MV3) extension into a loadable out/ directory. Use whenever the user asks to build, rebuild, package, or load the extension, or hits the "_next / reserved name" load error.
---

# Build the Chrome extension (the error-free way)

This repo is a Next.js static-export Chrome MV3 extension. A raw `next build`
emits `out/_next/`, which Chrome refuses to load ("Filenames starting with `_`
are reserved"). The safe path always pairs the build with `fix-extension.js`.

## Steps

1. **Build + auto-fix + verify** from the repo root:

   ```bash
   npm run build
   ```

   This runs `next build && node fix-extension.js`. The script renames
   `out/_next` → `out/assets`, rewrites references to relative `./assets/...`
   paths, and validates the result.

2. **Confirm success.** The command must end with:

   ```
   ✅ out/ is extension-ready — no "_"-prefixed paths, manifest.json + index.html present.
   ```

   If it exits non-zero or lists problems, do NOT hand `out/` to the user —
   re-run `npm run build` and surface the error.

3. **If `out/` is already broken** (e.g. a previous `next build` ran on its own),
   repair in place without a full rebuild:

   ```bash
   npm run verify
   ```

4. **Tell the user how to load it:** `chrome://extensions` → enable
   Developer mode → **Load unpacked** → select the **`out/`** directory.

## Hard rules

- NEVER run `next build` / `npx next build` by itself — it re-creates
  `out/_next` and produces an unloadable extension.
- NEVER commit `out/` (it is gitignored).
