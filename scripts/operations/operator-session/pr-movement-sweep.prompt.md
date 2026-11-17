Run `node scripts/operations/operator-queue.mjs` from the operating checkout. Report NEEDS YOU and RULING NEEDED items with their reasons and suggested commands. Honour the operator's quiet hours: defer routine notifications during quiet hours according to the handoff rules. Report read failures as unknown; never infer that the queue is clear from an incomplete read.

<!-- Generated from scripts/lib/no-prompt-command-rules.mjs; whole-tree test pins this copy. -->
<!-- no-prompt-command-rules:begin -->
## No-prompt command rules

- Plain single commands only: no `$(...)`, no shell variables or arrays, no loops, no trailing `&`.
- Edit files with the Edit/Write tools, never `sed -i`, `perl -i`, or redirect writes.
- Never `rm -rf` / `rm -r`: write scratch into a NEW uniquely named dir instead of deleting.
- Never `git reset --hard`, `git push --force`, `git clean`. To continue a branch in a lane: `git fetch origin <branch>` then `git merge --no-edit FETCH_HEAD`, then push `HEAD:refs/heads/<branch>`.
- Stop background jobs with the job tool (TaskStop or `kill <exact pid>`), never `pkill`/`killall`.
<!-- no-prompt-command-rules:end -->
