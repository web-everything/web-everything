---
name: project_bootstrap_patches_inject_footgun
description: Frontier UI Vite plugin skips bootstrap injection if a demo HTML mentions the literal bootstrap path
metadata: 
  node_type: memory
  type: project
  originSessionId: 51356f9d-1251-40ec-985c-677fe9207056
---

In Frontier UI (`~/workspace/frontierui`), the Vite `bootstrapPatches()` plugin
in `vite.config.mts` auto-injects `<script src="/plugs/bootstrap.ts">` into every plugged
`demos/*.html` — but it **bails if the HTML already contains the literal string `/plugs/bootstrap.ts`**
(a double-injection guard: `if (html.includes('/plugs/bootstrap.ts')) return html;`).

**Why it bites:** writing that exact path in a demo's prose, `<code>`, or HTML comment silently
disables injection, so `window.attributes` is never created and the plugged trait path looks broken
with no error.

**How to apply:** in a plugged demo never write the literal `/plugs/bootstrap.ts` anywhere in the
HTML — refer to it as "the plugged bootstrap module" instead. Hit while building #133's
`demos/lazy-traits-plugged.html`. Related: [[project_dev_panel_plugin_duplicated]] (the same kind of
Vite-plugin duplication/quirk between repos).
