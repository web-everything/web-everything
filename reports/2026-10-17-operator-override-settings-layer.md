# Operator-override settings layer (db-backed) — prior-art and grounding

Date: 2026-10-17. Backs decision card xouq5b0.

## Motivation (live cases, 2026-10-17)
A settings change was blocked because its file was held by an open PR: `we:scripts/settings/merge-queue.json` held by #5480, and the review settings files held by #5465 and #5482. Every tweak needed a PR round.

## Grounding in the tree
- The cascade resolver is `resolveCascade` in `we:scripts/lib/policy-cascade.mjs:98`. Layers are `CASCADE_LAYERS = ['standard','platform','tool','env']` (line 38). Source is logged by `logCascadeSources` (line 153) as `leaf=value (layer)`.
- Call-site helper `cascadePolicy` is at `we:scripts/lib/policy-cascade.mjs:176`.
- Feature settings files merge in `we:scripts/lib/settings-files.mjs:105` (`mergeSettingsLayers`) and `:132` (`readDeclaredSettings`).
- Review settings have their own resolvers and source reporter: the referral safety keys resolve through `resolveReferralSafetySettings` (`we:scripts/lib/review-settings.mjs:96`), the source through `resolveReviewSettingSource` (`:117`).
- Merge-queue switches resolve outside the cascade, through `resolveRefreshSetting` (`we:scripts/lib/merge-queue-enqueue.mjs:42`).
- Example of the layer wording: `we:scripts/settings/merge-queue.json:2` ("standard < platform < tool").
- The confirmed-broken-always-blocks floor: `we:scripts/lib/review-round-rules.mjs:268`.
- `.operations/` is machine-local and gitignored (`we:.gitignore:186`).
- The decision id `xugqjw1` (settings-edit authority) was NOT found by grep in the tree; the card flags it as an unverified citation.

## Prior art
- Feature-flag services (LaunchDarkly, Unleash, Flipt): a hosted store overrides code defaults, with an audit log and optional scheduled expiry. Lesson: expiry and audit are first-class.
- Kubernetes ConfigMap and Helm values: a live object overrides a chart default; a diff shows the delta. Lesson: show active overrides next to defaults.
- Consul/etcd dynamic config: a watched key overrides a static file. Lesson: per-tick reads are cheap for a local store.
- Terraform `-var` and `*.auto.tfvars`: operator overrides sit above module defaults and are recorded in state. Lesson: the override layer is an input, not code.
