# Development Guide

## Quick Start

Start the unified development environment with a single command:

```bash
npm start
# or
npm run dev
```

This starts both servers:
- **DOCS** (11ty): Port 8080 (internal only - proxied)
- **DEMO** (Vite): Port 3000 (public-facing)

**👉 You only need to remember: http://localhost:3000**

Everything is served through port **3000** with automatic proxying:
- `/demos/*.html`, `/plugs/*.ts` → Vite (TypeScript transformation/HMR)
- All other routes → 11ty (documentation pages)

## Scripts

### Antigravity binary maintenance

Schedule this single command hourly through the operator's existing daemon or cron,
with the checkout as its working directory and `agy` / `brew` on its PATH:

```sh
node scripts/operations/agy-upgrade-check.mjs
```

No daemon is installed. The check smokes `agy --version` (20 seconds), checks
`brew outdated --cask --json=v2` (60 seconds), upgrades only `antigravity-cli`
(120 seconds), then smokes again. Timed-out children are killed by exact PID;
combined child output is capped at 64 KiB. Unknown staleness skips the upgrade
and logs an operator diagnostic. A failed smoke immediately holds the seat for
24 hours and publishes a needs-you event; healthy smoke clears that hold.
Repeated failures deduplicate by version and failure state.

Settings resolve through the policy cascade with an empty platform layer and
environment overrides only; effective values and sources are logged:
`WE_AGY_UPGRADE_ENABLED` (default `true`),
`WE_AGY_UPGRADE_MIN_INTERVAL_MINUTES` (default/minimum `60`, maximum `1440`),
`WE_AGY_UPGRADE_SMOKE_TIMEOUT_MS` (default/maximum `20000`, minimum `1`).
State is atomically written under `~/.antigravity-quota/` (or
`ANTIGRAVITY_QUOTA_DIR`). Future, malformed, or oversized (8 KiB) run records
cannot suppress a check. An exclusive `upgrade-check.lock` directory prevents
overlapping runs. If the checker itself is killed, the operator must confirm
it has stopped and remove that lock directory before the next scheduled run.

| Command | Description |
|---------|-------------|
| `npm start` | Start unified dev environment (both servers) |
| `npm run dev` | Same as `npm start` |
| `npm run build` | Build both documentation and demos for production |
| `npm run build:docs` | Build only 11ty documentation |
| `npm run build:demo` | Build only Vite demos |
| `npm test` | Run unit tests with Vitest |
| `npm run test:integration` | Run E2E tests with Playwright |
| `npm run clean` | Remove build artifacts |

## Architecture

### Development Mode
```
┌─────────────────────────────────────┐
│  Single Port: http://localhost:5173 │
└──────────────┬──────────────────────┘
               │
        Vite Dev Server
               │
    ┌──────────┴────────────┐
    │                       │
    ▼                       ▼
/demos/*              Other Routes
/plugs/*                   │
/assets/*                  │
    │                      │
    │                Proxy to
    │                      │
    │                      ▼
    │              11ty Server (8080)
    │                      │
    ▼                      │
TypeScript           Static HTML
Hot Reload           Live Reload
```

### Production Build
```
npm run build
    │
    ├─> npm run build:docs (11ty)
    │   ├─> _site/index.html
    │   ├─> _site/projects/*
    │   └─> _site/...
    │
    └─> npm run build:demo (Vite)
        ├─> _site/demos/declarative-spa.html (optimized)
        └─> _site/assets/* (bundled)
```

## Features

✅ **Single Command**: `npm start` launches everything  
✅ **Single Port**: All development on port 5173  
✅ **Auto-Restart**: Servers restart on crashes (via concurrently)  
✅ **Unified Logs**: Color-coded output (blue=DOCS, magenta=DEMO)  
✅ **Hot Module Reload**: Vite HMR for TypeScript demos  
✅ **Live Reload**: 11ty browser sync for documentation  
✅ **Unified Build**: Single command builds entire site  

## Demo Development

The declarative SPA demo is at:
- Dev: http://localhost:3000/demos/declarative-spa.html
- Built: `_site/demos/declarative-spa.html`

All TypeScript imports are transformed by Vite automatically:
```typescript
import { CustomContext } from '/plugs/webcontexts/CustomContext.ts';
```

## Troubleshooting

### Ports Already in Use
```bash
# Kill existing processes
pkill -9 -f "(vite|eleventy)"

# Restart
npm start
```

### Build Errors
```bash
# Clean and rebuild
npm run clean
npm run build
```

### TypeScript Warnings
Some duplicate member warnings are expected during development. These don't affect functionality but should be cleaned up for production.

## Production Deployment

The entire site is static after building:

```bash
npm run build
```

Deploy the `_site/` directory to any static hosting:
- GitHub Pages
- Netlify
- Vercel
- etc.

All TypeScript is bundled and optimized by Vite.
