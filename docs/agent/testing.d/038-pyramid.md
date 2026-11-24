## Pyramid

| Tier | Pattern | Runner | Env | Purpose |
|------|---------|--------|-----|---------|
| Unit | `*.test.ts` | Vitest | happy-dom | Single class/function, mocked deps |
| Integration | `*.test.ts` | Vitest | happy-dom | Multiple components together |
| E2E | `*.spec.ts` | Playwright (`chromium`) | real browser | User flows on the live demo |
| SW / durable-tier | `*.sw.spec.ts` | Playwright (`chromium-sw`) | real browser, **SW allowed** | Service-worker + Background-Fetch reload-survival |

> **Real-browser service-worker lane (#684).** Vitest runs under happy-dom — **no service
> worker, no Background Fetch** — and the default `chromium` E2E project neither allows SW
> registration nor serves a SW origin. A verification whose proof needs a real runtime (e.g.
> #675's durable-tier reload-survival) must depend on a harness that provides it. The
> `chromium-sw` Playwright project is that harness: it runs `*.sw.spec.ts` in a context with
> `serviceWorkers: 'allow'`, served by the zero-dependency static fixture server at
> `plugs/__tests__/e2e/sw-fixtures/serve.mjs` (http://localhost:3210 — a SW-capable origin
> sending `Service-Worker-Allowed: /`). Drive reload-survival via the reusable
> `sw-fixtures/rehydrate-helper.ts` (`assertSurvivesHardReload(page, task)`): register → arm →
> hard-reload → assert the worker re-hydrated. The fixture's Background-Fetch feature-detect
> honours `window.__forceNoBgFetch`, so the degraded (navigation-guard re-arm) branch is
> exercised deterministically. **Residual manual step:** a true Background-Fetch *network*
> transfer surviving reload may need a flagged/real Chromium profile — drive what headless can,
> document the rest as the one manual check.

### Locations
```
plugs/{module}/__tests__/unit/*.test.ts
plugs/{module}/__tests__/integration/*.test.ts
blocks/__tests__/unit/{group}/*.test.ts
blocks/__tests__/integration/*.test.ts
plugs/__tests__/e2e/*.spec.ts
plugs/__tests__/e2e/*.sw.spec.ts          # real-browser SW lane (chromium-sw project)
plugs/__tests__/e2e/sw-fixtures/          # static fixture server + SW/page + rehydrate-helper
```

