# Discord AI Interface

**Policy-controlled Discord administration for AI agents.**

[![verify](https://github.com/Master0fFate/discord-ai-interface/actions/workflows/verify.yml/badge.svg)](https://github.com/Master0fFate/discord-ai-interface/actions/workflows/verify.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)](LICENSE)

An AI agent with a Discord bot token is an AI agent that can delete your server. This project gives an agent a narrow, typed, auditable path to Discord administration — and keeps a human in control of anything destructive.

It ships as two interfaces over one engine:

- **CLI** — the trusted operator interface. Inspect Discord, prepare exact proposals, approve by typing the canonical action hash.
- **MCP server** — the AI interface. Fixed read, propose, and execute tools. No generic HTTP route. No approval tool.

> ### Status: prototype
>
> The engine works and is tested — 17 typed actions, 80 automated tests, deny-by-default policy, append-only audit, and postcondition verification. But this is **not a hardened product**:
>
> - No external security review has been performed.
> - It has not been validated against live Discord at scale, and one path (`message.send`) has not yet been proven against the real API.
> - Interfaces, policy schema, and the state layout may change without notice.
>
> Use it, fork it, learn from it. Do not treat it as a supported release.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Capabilities](#capabilities)
- [Security model](#security-model)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Autonomous mode](#autonomous-mode)
- [MCP server](#mcp-server)
- [Configuration](#configuration)
- [Operation lifecycle](#operation-lifecycle)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

---

## Why this exists

Most Discord bot frameworks hand the agent an HTTP client and a token. That is an unbounded capability: every route, every target, every mistake is permanent.

This project takes the opposite position:

- The agent may only submit **typed actions** from a fixed set of 17. There is no raw request tool anywhere in the AI surface.
- Every action is checked against a **deny-by-default policy** that names exact guild, channel, role, and member IDs. There are no wildcards in the schema.
- Anything destructive requires **human approval** — the operator types the full SHA-256 action hash in a terminal. There is no `--yes`, no environment-variable bypass, and no model approval path.
- Success is never claimed from an HTTP status code. Every mutation is **verified against real Discord state** before it is recorded as `succeeded`.

## Capabilities

All 17 operations are implemented, planned, policy-checked, audited, and verified end to end.

| Domain | Operations |
| --- | --- |
| **Roles** | `role.add` · `role.remove` · `role.create` · `role.update` · `role.delete` · `role.reorder` |
| **Members** | `member.timeout` · `member.untimeout` · `member.ban` · `member.unban` |
| **Permissions** | `overwrite.upsert` · `overwrite.delete` |
| **Channels** | `channel.create` · `channel.update` · `channel.delete` · `channel.reorder` |
| **Messages** | `message.send` (embed-based, optional explicit `@everyone`) |

Deliberately **not** implemented: webhooks, invites, bulk operations, and any raw Discord route. A missing capability is added as a typed action — never as an escape hatch.

## Security model

| Control | Behavior |
| --- | --- |
| **Deny by default** | An empty policy grants nothing. A guild must be named, and each operation enabled per guild. |
| **No wildcard targets** | Roles, channels, and members are allowlisted by immutable snowflake ID. Display names are never used to identify a target at execution time. |
| **Protected targets** | Global and per-guild protected role and member lists that no policy widening can override. |
| **Permission-bit ceiling** | Channel overwrites may only touch permission bits inside a reviewed decimal bitset. Administrator, Ban, Kick, Manage Server, Manage Webhooks, and Manage Roles are excluded by design. |
| **Human approval** | A proposal produces a canonical SHA-256 hash over the normalized action. Approval requires typing the complete hash at a TTY. Confirmations expire and cannot be replayed. |
| **State-drift detection** | The full Discord state a preview depends on is hashed. If that state changes before execution, the operation fails instead of applying a stale plan. |
| **Postcondition verification** | After every mutation, Discord state is re-read and compared to the planned result. A mismatch marks the operation `uncertain`, never `succeeded`. |
| **Append-only audit** | Every step is written to a JSONL audit sink. If the audit write fails, the operation fails closed. |
| **Crash safety** | Atomic file replacement, cross-process locks, and a documented `recover` / `reconcile` path for interrupted executions. |
| **Secret boundary** | The token comes only from the environment. A `Secret` wrapper redacts itself in logs, JSON, and inspection. Log output redacts secret-like keys and Discord-token-shaped strings. |
| **Rate-limit discipline** | Per-route and per-bucket tracking, `429` backoff, and bounded retry budgets. |

No security guarantee is claimed beyond what the test suite and the [threat model](docs/threat-model.md) actually cover.

## Quick start

**Requirements:** Node.js 22.12+, npm, and a Discord **bot** token. User tokens and self-bots are not supported.

```sh
git clone https://github.com/Master0fFate/discord-ai-interface.git
cd discord-ai-interface
npm ci
npm run build
```

Create the local configuration and policy:

```sh
cp discord-ai.config.example.json discord-ai.config.json
cp discord-ai.policy.example.json discord-ai.policy.json
```

Supply the token through the environment. It must never appear in JSON, source code, command arguments, prompts, or logs.

```sh
node --env-file=.env dist/cli.js setup
node --env-file=.env dist/cli.js status
```

Inspect Discord without mutation:

```sh
node --env-file=.env dist/cli.js guilds
node --env-file=.env dist/cli.js channels GUILD_ID
node --env-file=.env dist/cli.js roles GUILD_ID
node --env-file=.env dist/cli.js member GUILD_ID MEMBER_ID
```

Then propose one typed action:

```sh
node --env-file=.env dist/cli.js propose --action-json '{
  "type": "overwrite.upsert",
  "guildId": "GUILD_ID",
  "channelId": "CHANNEL_ID",
  "targetId": "ROLE_ID",
  "targetType": "role",
  "allow": "1024",
  "deny": "0",
  "reason": "Operator-approved channel visibility update"
}'
```

The proposal prints immutable IDs, the exact before/after diff, consequences, warnings, risk, reversibility, and the canonical action hash. A human then approves it in a terminal, and executes it:

```sh
node --env-file=.env dist/cli.js approve OPERATION_ID   # type the full hash at a TTY
node --env-file=.env dist/cli.js execute OPERATION_ID
node --env-file=.env dist/cli.js operation OPERATION_ID
```

## CLI reference

| Command | Purpose |
| --- | --- |
| `setup` | Validate configuration and create the state directory |
| `status` | Verify bot connectivity and report policy status |
| `config check` | Validate configuration without connecting |
| `guilds` · `guild` · `channels` · `channel` · `roles` · `member` · `bans` · `audit` | Read-only inspection by immutable ID |
| `propose --action-json JSON` | Policy-check and preview exactly one action |
| `propose-nl TEXT` | Draft an action from natural language via a configured OpenAI-compatible endpoint |
| `approve OPERATION_ID` | Interactive TTY approval; requires the complete action hash |
| `execute OPERATION_ID` | Revalidate and execute an approved operation |
| `operation OPERATION_ID` | Read durable operation status |
| `recover OPERATION_ID NOTE` | Mark a crash-interrupted execution `uncertain` |
| `reconcile OPERATION_ID succeeded\|failed NOTE` | Record an operator's authoritative reconciliation |
| `auto --action-json JSON` | Plan and execute in one step (autonomous guilds only) |
| `auto-nl TEXT` | Natural-language autonomous execution |
| `batch --actions-json '[…]'` | Up to 20 independent typed actions, each through the identical pipeline |

## Autonomous mode

A guild marked `"autonomous": true` in the policy lets the agent plan and execute authorized operations without per-action approval. The owner grants this scope **once**, in the policy file. The agent cannot widen it.

```json
{
  "guilds": {
    "GUILD_ID": {
      "autonomous": true,
      "operations": ["channel.create", "overwrite.upsert", "message.send"],
      "channelIds": ["CHANNEL_ID"],
      "roleIds": ["ROLE_ID"],
      "memberIds": [],
      "allowedPermissionBits": "3072",
      "trackCreatedChannels": true
    }
  }
}
```

With `trackCreatedChannels` / `trackCreatedRoles`, resources the bot creates are automatically authorized for follow-up management, so routine work needs no policy edits. Members remain allowlisted at all times: the agent cannot moderate or assign roles to a member ID that is not listed.

Every autonomous action still produces a durable operation record and a full audit trail, and is still verified against Discord state before success is claimed.

## MCP server

The MCP surface is fixed and typed. It deliberately exposes **no approval tool** and **no generic Discord request tool**.

```sh
node --env-file=.env dist/mcp.js
```

| Tool | Purpose |
| --- | --- |
| `discord_read_guilds` · `discord_read_guild` · `discord_read_channels` · `discord_read_roles` · `discord_read_member` · `discord_read_audit_log` · `discord_read_bans` | Authorized read-only inspection |
| `operation_propose` | Policy-check and preview one action; never approves or executes |
| `operation_execute` | Execute one already human-approved operation |
| `operation_execute_autonomous` | Plan and execute one action in an autonomous guild |
| `operation_execute_autonomous_batch` | Up to 20 independent actions, results reported per action |
| `operation_status` | Read durable operation status |

Example client configuration:

```json
{
  "mcpServers": {
    "discord-ai-interface": {
      "command": "node",
      "args": ["--env-file=.env", "dist/mcp.js"],
      "env": { "DISCORD_AI_POLICY": "./discord-ai.policy.json" }
    }
  }
}
```

Discord-provided text returned by read tools is untrusted data. Tool results are labeled with `source` and `trust` so the model treats channel names, topics, and reasons as content — never as instructions.

## Configuration

The token is accepted **only** from `DISCORD_BOT_TOKEN`. JSON configuration is deliberately non-secret.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | Bot token; environment only |
| `DISCORD_AI_POLICY` | For mutations | Path to the deny-by-default policy file |
| `DISCORD_AI_DATA_DIR` | No | Durable state directory (default `.discord-ai-interface`) |
| `DISCORD_AI_CONFIG` | No | Path to the non-secret JSON configuration |
| `DISCORD_API_BASE_URL` | No | API base URL; HTTPS, or loopback HTTP for local testing |
| `DISCORD_REQUEST_TIMEOUT_MS` | No | Request timeout, 1000–60000 |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`, or `silent` |
| `OPENAI_API_KEY` · `OPENAI_BASE_URL` · `OPENAI_MODEL` | No | Natural-language proposal provider |

Unknown JSON properties are rejected. Configuration errors name invalid fields but never echo values. Structured logs go to stderr and redact secret-like keys, registered secrets, and Discord-token-shaped strings.

## Operation lifecycle

```
proposed ──▶ approved ──▶ executing ──▶ succeeded
    │            │             │
    │            │             ├──▶ failed
    │            └──▶ failed   └──▶ uncertain ──▶ succeeded | failed
    │                                    (operator reconcile)
    └──▶ failed (policy denied / preflight failed)
```

`uncertain` means the mutation may or may not have applied. The project never blindly retries it: an operator inspects Discord and the audit log, then reconciles explicitly.

## Documentation

| Document | Contents |
| --- | --- |
| [Setup and operations](docs/setup-and-operations.md) | Discord application setup and operator workflow |
| [Threat model](docs/threat-model.md) | Assets, adversaries, and mitigations |
| [Least privilege](docs/least-privilege.md) | Required bot permissions per capability |
| [Examples](docs/examples.md) | Policy and action examples |
| [Recovery and token rotation](docs/recovery-and-token-rotation.md) | Runbooks for failures and exposure |
| [Verification](docs/verification.md) | Quality gate and the credential-blocked live test |
| [Autonomous mode](docs/autonomous-mode.md) | How autonomous scope is granted and bounded |

## Development

```sh
npm run verify      # lint, strict typecheck, tests, build, smoke, dependency audit
npm run test:watch  # focused development loop
```

`verify` runs ESLint, strict TypeScript, the full mocked suite (80 tests including CLI, MCP, and adversarial security cases), a production build, dedicated CLI/MCP stdio smoke checks, and a high-severity dependency audit. CI runs the same gate on every push and pull request.

Only the documented disposable-guild live test needs real credentials. It is never run against a production guild.

## License

[GNU Affero General Public License v3.0](LICENSE) — free software, and OSI-approved open source.

You may use, study, modify, distribute, and sell this software. If you distribute it, or run a modified version as a network service, **you must publish the complete corresponding source under the same license**. That is the deal: the code stays free for everyone who builds on it.

Copyright (C) 2025 Master0fFate. See [LICENSE](LICENSE) for the full terms.
