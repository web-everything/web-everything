---
bornAs: xvnwljh
kind: story
size: 2
status: resolved
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-09-29"
dateResolved: "2026-10-01"
preparedDate: "2026-09-30"
preparedAgainstSha: "940b7dd328d118b0c398a2f1fcef96608629ce01"
tags: []
---

# Daemon rebuild prunes untracked backlog sidecars already landed on main

Follow-up to the orphan prevention-card sweep (PR #2901/#2904, 2026-09-29): daemon clones such as wev-review-daemon retain provisional, untracked cards under we:backlog/ after their numbered counterparts land. Add narrowly bounded cleanup in we:scripts/lib/daemon-rebuild.mjs: after a successful main fetch, remove only untracked provisional card files whose hash has a matching `bornAs` in a numbered card on the fetched main commit. Preserve every other path and existing rebuild safety checks.

## Progress

- **Original premise/scope:** the dirty check ignores untracked we:backlog/x*.md sidecars, no sanctioned cleanup exists, and the next rebuild should remove 22 already-landed copies. Scope named only we:scripts/lib/daemon-rebuild.mjs, with no test file.
- **Verified current premise:** we:scripts/lib/daemon-rebuild.mjs:395 collects untracked, non-ignored paths; `findUnsafeLocalState` at line 426 checks tracked dirt separately. `prepareRebuild` reports `untracked-kept` at line 1365, fetches at line 1382, and returns `up-to-date` at line 1437. There is no `bornAs` lookup or backlog-sidecar deletion in the current module. Existing preservation/collision tests live in we:scripts/lib/__tests__/daemon-rebuild.test.mjs:314 and the no-op reporting test at line 488. The goal remains undelivered in this checkout.
- **Corrected scope:** retain the existing source home and add its matching test, we:scripts/lib/__tests__/daemon-rebuild.test.mjs. Cleanup must run on successful-fetch no-op ticks as well as adopting ticks, within the existing write lock (we:scripts/lib/daemon-rebuild.mjs:1741). Only direct, non-ignored, untracked regular provisional card files qualify; the broad we:backlog/x*.md description is not a deletion predicate. The historical count of 22 is not a measured current inventory and must be re-established during live proof.
- **Identity evidence:** we:scripts/backlog/id.mjs:23 defines a provisional ID as `x` plus exactly six lowercase base36 characters. `landedNumberFor` in we:scripts/lane-drain.mjs:1022 establishes the numbered-card/`bornAs` proof-of-land convention, but its whole-file grep is not sufficient by itself for destructive cleanup: a body example must not authorize deletion. Read the actual leading frontmatter from the pinned main tree. These are read-only reference dependencies, not additional edit scope.

- **Implementation proof (2026-10-01):** the new current-HEAD rebuildClone regression failed before the source edit (expected sidecar existence false, observed true); with cleanup implemented it passes, including three subsequent no-op ticks and unchanged survivor bytes/HEAD.
- **Read-only live inventory (2026-10-01):** designated clone wev-review-daemon, HEAD 01bb3d9489728ce59e93e6d4639d6df0ca840b8f, locally observed origin/main 01bb3d9489728ce59e93e6d4639d6df0ca840b8f (not freshly fetched by this session). 75 direct regular untracked provisional cards; 72 have numbered-card frontmatter identity matches at that commit; 3 lack that evidence. Exact paths, evidence paths and before SHA-256 digests follow. No files were deleted. This clone and its operational state are outside the session's writable roots, with escalation disabled: a normal rebuild with this implementation and its second tick cannot run here. **Live cleanup remains unproven; no after counts or unchanged-survivor claim is inferred from fixture tests.**

| Before candidate | Numbered evidence at observed main | Before SHA-256 |
|---|---|---|
| we:backlog/4407-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4407-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 61f31002aae249a58e1706dc102ceac8a0b1bb70263278de31e39bc0b64213da |
| we:backlog/4408-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4408-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 78f3dccdd6137300c2dba2d168f8452d621073090a554c1b43e01572aa82c69a |
| we:backlog/4409-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4409-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 94746412a6df6a89bb9254eee876b05aea6bd260a9428d37099d9c45f168912a |
| we:backlog/4410-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4410-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 5d6e98ccf1f5f730ee44f27221d9817ab6699a862b6dbecfd018d230ce547d3b |
| we:backlog/8432-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | No numbered frontmatter match | 0b8b45a542b53b8d8ccfcbc23436a84e73bf1162118998e07ab0efc0ea32acc3 |
| we:backlog/4316-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4316-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 2f4b599022f90c62e5524b5d335f51c6517e535dee3975e85024607da1e49240 |
| we:backlog/4411-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4411-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | d06f35198f9a7154fbdf67703cc8c9732deee3eb92f4f9bd225411d83624a9de |
| we:backlog/4412-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4412-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 0590f8036b64cde3d8ca6c0a9abde5ecfe33bc94c00ef713f1b692674a61a463 |
| we:backlog/4413-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4413-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f75795e7c87449afde66bf7ae54f76e6411d709dd1067e9c73b0f7be514f26e7 |
| we:backlog/4414-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4414-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 7cf5aef8b0fbb9c8ec8180ce2df8568ec0d2de034470c1425d4c0bfaff41d4a6 |
| we:backlog/4318-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4318-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 4dd99fbe1c5fe5f9d5e358f30d5193936110680dc67d988a465aaa21830dc70b |
| we:backlog/4319-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4319-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 6f6cfc13b8fc79493efe774aa0bd924beb93efe9619ab98f7fa3fd7aafbae3c9 |
| we:backlog/4415-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4415-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 85ebe9584bd45b520d1c1f4a86b3b0dc0534f4e9e8bb677a4dbd251135329bc1 |
| we:backlog/4416-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4416-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 47da4aa6c5a7274aa53cfd6e2528226d24a7c5935ca12154f7df5f282555ff9d |
| we:backlog/4417-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4417-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | aa4abd641e206d7fda1c456a8be1e1b11e62749474e36ea5937e78c565c91a4b |
| we:backlog/4320-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4320-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 7cd27549a01b8fe30041e4391e379356e02ae3e5d721e43c1a69a3917ad9c2bf |
| we:backlog/4321-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4321-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 16b34a056c425536c60c20df940f719683635c1130b0bb37d0a266d6deeb32ec |
| we:backlog/4418-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4418-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 05cf474ace1cfde554ed86ce103e5659b99ed8ae5d99df957cc885adf6d054d0 |
| we:backlog/4322-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4322-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | a3586cc8234712fc8381737e0164ec74cdf22385495227c4a8be0cf3fcbb1576 |
| we:backlog/4323-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4323-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 855dbba069a8bce74f4bd0bcacac1ba3924453f3e4fbf4f906e99845fc388d1e |
| we:backlog/4419-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4419-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 8462bf405c9a7e84a9b39435e7e1e6a53a2f4d6b5cbbececaf87fd00333f60ee |
| we:backlog/4324-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4324-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 0b6f05be9735ac9eef6b5887e50f73cc74d566cd63f4fae61c9d8a124542a198 |
| we:backlog/4420-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4420-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | d6f2d77968d7151fa4ea6eed93614a7448597f0393b9a3bab8e6b7fa9a7872fc |
| we:backlog/8471-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | No numbered frontmatter match | 7da39463f0bd46199033c378e08f3ec099c0d9e435b1ee209242482316c70e60 |
| we:backlog/4421-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4421-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | eeb9674322a57dcb082505d790acb0c77e95abca78baa6e9ae1c4cbdfd46a8f0 |
| we:backlog/4325-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4325-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 9fa49484640574a75469f43f269679ec14207122bba0e56cb031bf2ff911a6b5 |
| we:backlog/4422-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4422-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 2c5f6ab999e4ec33edd5e7debed61a5986a51b4761770e8180ff6c8db2768b45 |
| we:backlog/4423-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4423-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 72b63a22aba165b485b80bcf3d6b002ee2b3ed13bf8b0543cd9f342e2e091f08 |
| we:backlog/4424-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4424-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 6804aa7bb06aff675afa788349104f82c3d7d33b9ab9685f6ee34f5a33ac5c90 |
| we:backlog/4326-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4326-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 18a9b0827359191e99d54833aa9c290909bc1226f5dc1c12e4e1251c0a2d1708 |
| we:backlog/4425-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4425-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 24c97ac7e136f493523dd21ee9beca6cfa15e8bb9874c2081e377cc27fa128b1 |
| we:backlog/4426-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4426-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 1fe263ed20f0ed95a43f12f0184c243a9aa48c18b2fbed6a0170d905e5cff950 |
| we:backlog/4327-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4327-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 74f0d65880492989e0a31d984d23c7629e4a6116a33b5c09e8ed26f6660a46bd |
| we:backlog/4427-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4427-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | a3f33c53f0d64da12422fdd42baf54d30083ae6a03c9179248ebf7b296d16958 |
| we:backlog/4428-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4428-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | bbf525661ef50fcf06c6ae04970313ac3585d06488c82b62d11558d8ce2db66d |
| we:backlog/4328-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4328-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 4ebec7c7acc1b03ecd3f3c4aae81062c9043c8d5cc1004b1357b1f4cf0995bba |
| we:backlog/4429-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4429-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 7a1fbf136dd47dca578f17e394fd36ec144c091204248f3968abb03d961c909b |
| we:backlog/4430-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4430-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 26d782ada68893483f28ae15bc54b6bc5d5cbe2df9a0e711adbd9027e1fd996f |
| we:backlog/4329-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4329-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | b70ee7f3ec911967ecfa4c2720f4e38afeb60cc6a2105f218acd30f91ab4b2c3 |
| we:backlog/4431-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4431-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 570dfb9acba735317f76c733db36eabd6be4fb6c5971621ba1dbef27f151a3d8 |
| we:backlog/4330-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4330-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 1739a23a0d1383320e2df1654315bf9aa128a6535ffb8a1db3ed00f5c698cb2a |
| we:backlog/4432-file-the-prevention-guard-s-owed-by-chalbert-plateau-app-187.md | we:backlog/4432-file-the-prevention-guard-s-owed-by-chalbert-plateau-app-187.md | f638de0505b575eeee3d1e51d2cbf25906ebd2ae800c1b8f1ff63104b9615bc4 |
| we:backlog/4433-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4433-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | fbe35d5e531a8475a142eafa480919a456d95c70f97e416435f503ec7f0ef7c7 |
| we:backlog/4434-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4434-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | b4ee90ea4252b4ed8ee531ab936c786dccdc1da30f40bc0e3dbab19b9fd39dd6 |
| we:backlog/4435-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4435-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 2a6615499b4138e9b824ade4f21820a734bd47642abd7a53df56da11ce217d7f |
| we:backlog/4331-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4331-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f172e8889528e29c08fc4cdaf85be53eed2b01095684ff5a4b27f91e7bf6f852 |
| we:backlog/4436-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4436-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 33cf9e1a1528e6d7deca98aafa7b3915ddb77bc51ae20dba91657ffa18dba2cd |
| we:backlog/4332-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4332-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | ddad6a3c03274d548e66452aed42d50bd2619bde1e0c5c08e6d37d620507a211 |
| we:backlog/4437-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4437-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | dd2f3d8945dc7ede1c0258e31a68ebaedda6cf1841e962387ba156109d8270d2 |
| we:backlog/4438-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4438-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | a7813c418de096d9313d3556d241df60cd71593d254a79cca623439359d51a6b |
| we:backlog/4439-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4439-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 15d7fae6248e438308ecd6b7ea23fd12b57c01b706ed7938e1d6d2d0acebf0e0 |
| we:backlog/4440-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4440-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | c47b0d545710c03e002ba285d6cab1ed669b13946ad88c0f246f32093702be9e |
| we:backlog/4441-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4441-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f06cb7ada03bbd11edb0a704827e2dd1b24e94bc4448a59dc5dec53c4839e49e |
| we:backlog/4333-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4333-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 83a6756bbe38974f917d72a213773edf0ccd998fd1c0236a7ac520ade4fcd951 |
| we:backlog/4442-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4442-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 536fe68b0286995167d08c684cf1b630d94df5ee71eca572f3f2f0dad25e879d |
| we:backlog/4443-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4443-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | be888d5589591cb342e11b2a38133699e560d627c9a77a982b858fbf3801a0f9 |
| we:backlog/4444-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4444-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 60542f06d49d98a7f4c325f8b85c12c2b49a3e1ac44da47e030439b5a9666951 |
| we:backlog/4445-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4445-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 406ae089c0b38d96dc21738c01f0003dee115998ac21952cad0fa66ab69e120e |
| we:backlog/4446-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4446-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 4c5c1109d21cb1fba188a233402ba6c82be968c1f7008b84b181e294333b1869 |
| we:backlog/4447-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4447-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 3cdba7da2a2c03d4521ad00e8e4cc549892227eab034fd45886ed58f634dbe86 |
| we:backlog/4448-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4448-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f1466f51f423fc5975f53de8bca316c22560b57d8c5e9b1dd9b7cd817af6b964 |
| we:backlog/4334-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4334-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 9816c530dde3852e5b8d601f24b55939691e51dd644e80e09b289b3ad611e16b |
| we:backlog/4449-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4449-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 11314bc07ffdcb2ec572eb848e88073c885e4bf3867d47e1fb7d02532b76974a |
| we:backlog/4450-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4450-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 82a9e341bcc542e5a294c539cdc46edbbbbc3a7311a8609a72d9376daf593f7f |
| we:backlog/4451-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4451-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 1842776b1f1cf88150a5a82014462ff54ad3802da3a4cd46baad4b1dfb3b3769 |
| we:backlog/4452-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4452-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | c8b4156d129e8cd0cc87270577ada16231b5118dd187e564396339329a9dde1e |
| we:backlog/4335-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4335-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f68496023303ee4d2768ba2bced041c6307022567b43e4f521fd0e828a86fa9d |
| we:backlog/4336-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4336-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 37529848533a69e79dfadfc8fcabf3b865c3ee939d6a51555d4256e08da6aaa1 |
| we:backlog/4453-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4453-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 1fa8f04af7edf709658bcb229a96012cc7924137e2926770d3f81cdfb0b7b189 |
| we:backlog/4454-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4454-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 457c77077e5a9d38f83ecf62e30cdc1b36c57a140d0a2584245288798c90e43b |
| we:backlog/4455-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4455-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f12b3e139237c44beddc0599788f3167e09ef0a1bf0f5e90e10dcf3b7dc76c2c |
| we:backlog/xygk1iy-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | No numbered frontmatter match | 30d002fd41a2f2db6da0c18fff6bafd76861a5409437f64ec18f2c4eef1bcd85 |
| we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4456-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | 09a526657060ad396161bbf08ed27207eff01b006facec16d8f8e7ea8b178f7f |
| we:backlog/4338-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4338-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | f8f4d9a24d419ed77d510f7562d61ee2d37eb36ea9d8d24009c62481f0697b51 |
| we:backlog/4339-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | we:backlog/4339-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md | eae828fc0c0a56395a293ab4ef59810cac910a2e1391aac785cd1f12e8996eb4 |

- **Regression checks:** the affected rebuild suite plus the existing ready and fallback suites passed together (141 tests across three files). The standards gate passed with zero errors (4590 warnings). Additional pinned-ref, SHA-read and membership-read cases are included in the final lane verification.

- **Wider-gate first run:** we:scripts/verify-lane.mjs ran 202 files / 9390 tests: 9374 passed, eight skipped, eight failed. Two dispatch-path failures were caused by the unnecessary editor dependency and fixed within scope (ten targeted cases now pass); six real-process-table failures are in we:scripts/operations/__tests__/restart-runner-io-real.test.mjs and we:scripts/operations/__tests__/clear-stuck-session-io-real.test.mjs. A direct Node spawnSync probe of ps returned EPERM (status null), confirming the session sandbox denies the required process-table access. No tests or gates were weakened. The final-code rerun completed: 200 files passed, two failed; 9376 tests passed, eight skipped, six failed, all six the sandbox-denied process-table cases above. All 144 tests in the three required daemon-rebuild suites passed (101 + 21 + 22). The verification marker correctly remains red; no bypass or alternate gate was used.

## Design

1. Add a small cleanup helper in we:scripts/lib/daemon-rebuild.mjs, using the existing injected Git runner and alert channel. Call it inside `prepareRebuild` after successful fetch and before planning/early returns. Resolve the fetched main commit once and use that immutable SHA for every proof lookup; never use the working tree, an overlay, or local numbering bookkeeping as landing evidence.
2. Enumerate candidates through `collectUntrackedPaths`. Accept only direct Markdown card paths under we:backlog/ whose filename stem yields a hash through `idFromName` and `isHash` from we:scripts/backlog/id.mjs. Require the parent directory and candidate to be real directory/regular file entries, not symlinks; do not traverse nested directories. Ignored files, tracked files, numbered cards, malformed IDs and non-card paths remain untouched.
3. Read numbered Markdown card blobs under we:backlog/ at the pinned main SHA. Use the leading frontmatter only, requiring a single valid top-level `bornAs` scalar exactly equal to the candidate hash; accept the normal plain and quoted scalar forms. Missing, ambiguous or malformed evidence never authorizes deletion. Reuse the scalar-reading convention in we:scripts/backlog/frontmatter.mjs without changing that module. Do not equate a grep match in prose with frontmatter evidence.
4. Recheck candidate untracked membership and filesystem type immediately before unlinking each eligible file under the write lock. Unlink that exact file only; never invoke broad cleanup, recursive deletion or deletion of the containing directory. An absent file is an idempotent no-op. On evidence/read/delete errors, retain the affected file and emit an actionable alert; unrelated rebuild work may continue through its existing safety gates.
5. Report successful removals with candidate path, hash, landed card path and main SHA through the existing alert mechanism. Refresh `unsafe.untracked` after cleanup so cached-ready and normal collision checks see the remaining paths; a failed refresh refuses through the existing status-failure behavior. Move normal `untracked-kept` reporting after cleanup, preserving it on fetch-failure returns. Keep finalization's independent safety recheck. Update the module comments that currently promise every untracked path is preserved to name this narrow exception.
6. `dryRunRebuild` remains read-only and never calls the deletion helper. No additional maintenance command, state file or cross-repository implementation is needed. Preserve the lock/refusal boundaries in [we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle](../docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle).

## MVP

- Implement the helper and locked post-fetch integration in we:scripts/lib/daemon-rebuild.mjs, including fail-closed evidence, precise unlinking and audit output.
- Add real temporary Git repository cases in we:scripts/lib/__tests__/daemon-rebuild.test.mjs, using its existing bare-origin/author-clone fixtures and injected smoke function.
- Deliver the source and regression cases together. Cleanup is keyed by durable birth identity, not byte equality with the renumbered card: numbering legitimately changes its contents. No changes to filing, numbering, overlays or daemon scheduling are part of this item.

## Test plan

Extend we:scripts/lib/__tests__/daemon-rebuild.test.mjs with these assertions:

- A numbered main card with matching `bornAs` removes its untracked provisional copy after fetch, including when HEAD is already current. Repeat the rebuild: no second removal event and no error.
- Main has advanced but the clone has not adopted it yet: the freshly fetched numbered card is sufficient evidence. Conversely, a match present only in an overlay or local working-tree card does not qualify.
- Unlanded hashes, prefix-only hash matches, body-only `bornAs` examples, malformed/duplicate frontmatter and non-numbered proof files retain the candidate. Exercise plain and quoted valid values.
- Non-card paths, numbered local cards, tracked provisional cards, ignored files, nested paths, directories and symlinks remain intact. Include an untracked collision sentinel and verify the existing refusal still protects it.
- Fetch/proof-read failures remove nothing dependent on the failed evidence; an unlink error retains the file and reports failure without inventing success. Simulate a candidate becoming tracked before unlink and a failed post-cleanup inventory read.
- Dry run preserves candidate bytes, index and refs. Successful cleanup reports only actual deletions; `untracked-kept` contains surviving paths, and a cached-ready adoption does not consume a stale pre-cleanup list.

Run the affected Vitest file, then the existing we:scripts/lib/__tests__/daemon-rebuild-ready.test.mjs and we:scripts/lib/__tests__/daemon-rebuild-fallback.test.mjs regression suites, followed by `npm run check:standards`. Run commands from the WE root, stripping the `we:` citation prefix when supplying file arguments.

## Proof plan

First demonstrate the new landed-sidecar regression failing on the pre-change source and passing with the implementation in the same temporary-repository fixture. This must exercise `rebuildClone`, not only a helper.

For live proof after delivery, inventory the designated wev-review-daemon clone before a normal rebuild tick: record HEAD, the fetched main SHA, exact untracked candidates, corresponding numbered cards and survivor file digests. Observe one successful-fetch rebuild using the new code and capture its deletion alerts and post-tick inventory. Every removed path must have recorded main-tree `bornAs` evidence; every non-eligible sentinel must survive unchanged. Observe a second tick to prove idempotence. Do not manually delete files to manufacture the result. If 22 eligible copies still exist, all 22 must disappear; otherwise report the actual before/after counts. An inaccessible clone or zero eligible candidates leaves live cleanup unproven, even with passing fixture tests.

## Done when

1. The landed-sidecar `rebuildClone` regression in we:scripts/lib/__tests__/daemon-rebuild.test.mjs fails before implementation and passes afterward; preservation, failure and dry-run cases pass alongside the existing rebuild suites.
2. A successful-fetch no-op tick can prune proven landed sidecars without changing HEAD or relaxing tracked-dirt/collision refusals.
3. The live proof records the actual removed set, landing evidence and unchanged survivors; the standards gate passes.

## Follow-ups

No prerequisite design fork remains: the card already supplies the deletion policy, and this preparation bounds its implementation to provable landed identities. Preventing new approval-time sidecars or expanding cleanup to other artifacts is separate work. Do not delete an unproven leftover; record its path and reason during proof for later investigation.


- **Live-proof handoff:** run the two normal successful-fetch ticks in a session authorized to write the designated daemon clone and its state. Re-inventory first because the daemon is live; the observed 72 eligible / 3 unmatched split is not a promise about a later tick. Capture deletion alerts, verify every removed path against pinned-main frontmatter, and compare survivor digests. Done-when #3 and resolution remain pending until this observation exists.

- **Testing lesson:** importing the scalar editor from we:scripts/backlog/frontmatter.mjs unnecessarily widened the review daemon dependency closure and failed two unchanged dispatch-staleness tests in we:scripts/operations/__tests__/review-dispatch.test.mjs. Keep the narrow scalar convention local after YAML validation; the editor/transition module is not needed by cleanup. The ten dispatch-path/staleness regression cases passed after removing that dependency.
