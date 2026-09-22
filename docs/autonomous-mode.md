# Autonomous mode

Autonomous mode removes the per-action human approval step for one guild. The owner
grants the scope **once** in `discord-ai.policy.json`; after that, the AI plans and
executes authorized operations in a single step, with the same preflight, verification,
locks, and audit trail as the human-approval path.

## Enabling it

In `discord-ai.policy.json`, for the target guild:

```json
{
  "guilds": {
    "GUILD_ID": {
      "autonomous": true,
      "trackCreatedRoles": true,
      "trackCreatedChannels": true,
      "operations": ["role.create", "channel.create", "channel.update", "overwrite.upsert", "message.send"],
      "roleIds": [],
      "channelIds": [],
      "memberIds": [],
      "allowedPermissionBits": "36957952",
      "maxTimeoutSeconds": 86400,
      "maxBanDeleteMessageSeconds": 0
    }
  }
}
```

- `autonomous: true` — the AI may execute authorized operations without hash approval.
- `trackCreatedRoles` / `trackCreatedChannels` — roles and channels the bot creates are
  recorded in `.discord-ai-interface/created-resources.json` and become authorized targets
  for follow-up updates, deletes, reorders, overwrites, and message sends.
- `operations` — the allowlist of action types. All 17 types are implemented.
- `roleIds` / `channelIds` / `memberIds` — the immutable-target allowlists. Member
  moderation and role assignment still require explicit member IDs. Adding the guild ID
  to `roleIds` authorizes the `@everyone` role as an overwrite target (the classic
  "hide this channel from everyone" setup).
- `allowedPermissionBits` — decimal cap for channel permissions an overwrite may set.
  The configured value (`36957952`) covers viewing, messaging, voice, and mention bits
  but excludes Administrator, Ban, Kick, Manage Server, Manage Roles, and Manage
  Webhooks. Raise it only after reviewing each bit.

## Using it

CLI:

```sh
node --env-file=.env dist/cli.js auto --action-json '{"type":"channel.create","guildId":"GUILD_ID","name":"welcome","channelType":"text","reason":"Server setup"}'
node --env-file=.env dist/cli.js auto-nl "create a #welcome channel and a Mod role"
```

MCP: call `operation_execute_autonomous` with one typed action, or `operation_execute_autonomous_batch` with up to 20 actions for rebuilds. `operation_propose`
reports `approval.required: false` for autonomous guilds.

CLI: `auto --action-json` (one action) or `batch --actions-json` (up to 20). A batch
composes independent typed actions; every action still runs the full single-action
pipeline and is reported separately.

## What still applies

- Secret boundary: the bot token is never read, logged, or sent anywhere.
- No generic Discord route access from the AI surface.
- Policy allowlists, protected targets, Discord role hierarchy, and preflight checks.
- Target locks, fail-closed state-drift checks, and postcondition verification.
- Durable audit trail: `autonomous_approved` -> `attempted` -> `succeeded | failed | uncertain`.
- `uncertain` results still require operator reconciliation before any retry.

## Performance

Autonomous execution is the fast path: it skips the redundant pre-mutation state
re-snapshot (the plan was built milliseconds earlier in the same process) and registers
created resources directly from the mutation response. Per operation that reduces
Discord API calls from ~10-11 to ~5 (bot identity is cached per process). Postcondition
verification still runs and still fails closed. For rebuilds that touch many objects,
`operation_execute_autonomous_batch` / `batch --actions-json` cut MCP/LLM round trips
from N calls to one (max 20 actions per call, each fully planned, audited, and verified).

## Prompt-injection note

Discord-provided names, topics, messages, and audit reasons are untrusted data. In
autonomous mode a malicious member message or channel name could steer the AI, so scope
matters: keep the operation allowlist to what the server actually needs, keep members
allowlisted, and never add the bot itself to `memberIds` (the service blocks targeting
the bot anyway). If a guild becomes hostile, set `"autonomous": false` and reconcile any
uncertain operations before re-enabling.
