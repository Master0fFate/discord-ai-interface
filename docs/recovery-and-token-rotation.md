# Recovery and token rotation

## Failed, uncertain, or interrupted operations

1. Stop all CLI/MCP processes using the data directory. Do **not** immediately retry a mutation.
2. Record the operation ID and preserve `operations.json`, `plans.json`, `confirmations.json`, and `audit.jsonl`.
3. Inspect the current Discord object by immutable ID and, where available, Discord's audit log.
4. Compare Discord state with the persisted preview's exact `before` and `after` values.
5. If status is `uncertain` and evidence is conclusive, run:

```sh
discord-ai-interface reconcile OPERATION_ID succeeded 'Discord state and audit log verified'
# or
discord-ai-interface reconcile OPERATION_ID failed 'Discord confirms mutation was not applied'
```

Reconciliation records an operator conclusion; it does not mutate Discord. If a crash leaves an operation `executing`, preserve evidence, stop every writer using the data directory, inspect Discord, and first mark the interrupted record uncertain:

```sh
discord-ai-interface recover OPERATION_ID 'process interruption; Discord state inspected'
```

Then use `reconcile` with the evidence-backed outcome. Neither command retries or mutates Discord. If correction is needed, create a new proposal only after resolving the old record.

If startup or an operation reports that durable state/target is busy after a process crash, stop **all** CLI/MCP processes using the directory. Locate only files ending in `.lock` under the data directory, read their JSON ownership metadata (`pid`, `createdAt`, and resource/target hash), confirm that the recorded PID is no longer running, preserve a copy for incident evidence, and then remove only those stale `.lock` files. Never remove a lock while its PID may still be active; never edit the JSON state files to clear a lock.

For corrupt state, do not hand-edit files. Stop the service, copy the complete directory for investigation, restore a known-good same-generation backup, and compare against Discord. If audit writes fail (disk full, permissions, read-only filesystem), repair storage before operating; execution fails closed before the mutation when the attempted record cannot be persisted.

## Discord token rotation

Rotate immediately after suspected disclosure, unexpected bot activity, operator/device compromise, or accidental inclusion in logs/prompts/history:

1. Stop the CLI/MCP process.
2. In Discord Developer Portal > Application > Bot, use **Reset Token**. The old token is invalidated.
3. Update only the trusted secret manager/process environment. Do not change JSON or source.
4. Remove exposed copies from shell history, CI output, process-manager logs, tickets, and prompts. If committed, purge repository history and notify every clone owner; rotation is still mandatory.
5. Restart and run `discord-ai-interface status`; verify the expected bot ID and guild scope.
6. Review Discord audit logs and local JSONL from before the rotation. Reconcile unknown operations and reduce permissions/policy if needed.

Rotating a token does not change the bot identity, permissions, or policy. Review those separately. Provider API keys used by `propose-nl` follow the provider's equivalent revoke/reissue procedure.

## Backups

Back up the entire state directory atomically while processes are stopped. Encrypt backups, restrict access, define retention, and test restore. Audit evidence can be copied to append-only/WORM storage for stronger tamper resistance. Never restore individual files from different points in time.
