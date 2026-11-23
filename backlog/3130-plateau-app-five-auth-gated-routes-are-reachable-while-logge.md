---
bornAs: xyefflx
kind: task
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: the first-external-access gate card (8694) is scheduled"
dateParked: "2026-11-22"
dateOpened: "2026-08-15"
tags: []
---

# plateau-app: five auth-gated routes are reachable while logged off (PRODUCT_ROUTES is missing /skills and the four /console-* routes)

Found while preparing #2512 (route-prefix migration). plateau-app:src/main.ts's PRODUCT_ROUTES array (isProductRoute's gate) omits /skills, /console-board, /console-cases, /console-ruling, /console-micro. syncAuthShell only bounces a logged-off visitor to /home when isProductRoute(path) is true, so these five are never gated — and .app-shell.logged-off .app-main (plateau-app:src/styles/layout.css:331-337) only re-centers content, it does not hide it, so a logged-off visitor who navigates directly to one of these URLs sees the real page. Fix: add the five routes' names to PRODUCT_ROUTES (post-#2512, their prefixed forms: /docs/skills, /loop/console-board, /loop/console-cases, /loop/console-ruling, /loop/console-micro), decide whether Plateau Loop's console surfaces are meant to be public or gated first (a product/judgment call, not purely mechanical), and add an e2e assertion that a logged-off visit to each is redirected. Independently verified live on plateau-app main @ 0d0ed9e during #2512's independent review.

Parked 2026-11-22 (PL-BETA-GUARDS: park until beta; beats the master-plan merge into DZ-SHELL). Unpark when: first external user gets access (first customer or public beta). The new route table (DZ-SHELL) should still declare a guard per route.

Gate card: 8694 (First external access (beta) release gate) refuses outside access while this card is not resolved. Unpark when the first-external-access gate card is scheduled.
