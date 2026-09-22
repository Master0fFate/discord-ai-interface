# Discord setup and operator guide

## 1. Create a least-privilege bot

1. In the Discord Developer Portal, create an application and add a **Bot**.
2. Do not enable a user token or self-bot. This program supports bot tokens only.
3. On OAuth2 > URL Generator select scope `bot`, then select only the permissions required by the enabled policy; see [least privilege](least-privilege.md).
4. Install it only in a disposable test guild first. Put the bot role above every role it may assign/remove and below protected/admin roles.
5. Copy the token once into a trusted secret manager or process environment. Never paste it into chat, an AI prompt, JSON, source, shell arguments, or a committed `.env`.

No source edit is required. Gateway intents are not needed because this program uses REST and does not connect to the Gateway.

## 2. Install and configure

Use Node.js 22+ and a lockfile-controlled install:

```sh
npm ci
cp discord-ai.config.example.json discord-ai.config.json
cp discord-ai.policy.example.json discord-ai.policy.json
```

Edit non-secret config and policy. Replace example snowflakes with IDs copied using Discord Developer Mode. Start with one guild, one operation, and one target. Empty or absent allowlists grant nothing.

Set runtime variables through the service manager (shell syntax varies):

```sh
export DISCORD_BOT_TOKEN='secret-from-manager'
export DISCORD_AI_CONFIG="$PWD/discord-ai.config.json"
export DISCORD_AI_POLICY="$PWD/discord-ai.policy.json"
export DISCORD_AI_DATA_DIR="$HOME/.local/state/discord-ai-interface"
```

Protect them and run one process per data directory:

```sh
umask 077
npm run build
node dist/cli.js setup
node dist/cli.js status
```

`setup` creates the local data directory; `status` verifies token access and reports the bot identity. Keep the policy and state directory writable only by the dedicated operator account.

## 3. Normal operation

1. Inspect immutable IDs with `guilds`, `channels GUILD_ID`, `roles GUILD_ID`, `member GUILD_ID MEMBER_ID`, or `bans GUILD_ID`.
2. Propose one typed action. See [examples](examples.md).
3. Review IDs, reason, before/after diff, consequences, warnings, risk, reversibility, and the complete action hash.
4. In a local interactive TTY, run `approve OPERATION_ID` and type the displayed hash exactly.
5. Run `execute OPERATION_ID` separately. Check `operation OPERATION_ID` and Discord.
6. Review `.discord-ai-interface/audit.jsonl` (or the configured directory). Do not edit it.

Do not automate approval or pipe hashes into the CLI. There is intentionally no `--yes`. Natural-language proposals are untrusted and follow the same steps.

## MCP stdio

Configure an MCP client to launch `node /absolute/path/dist/mcp.js` with the same environment. Keep stdout exclusively for JSON-RPC; diagnostics belong on stderr. The fixed tools expose reads plus propose, execute, and status—never approval or a generic route. After an AI proposes an operation, a human must run `discord-ai-interface approve OPERATION_ID` in an interactive TTY and type the exact hash. The AI may execute only after that separately trusted approval.

## Routine checks

- Review policy and Discord role order after administrator/role changes.
- Review audit and all `failed`, `uncertain`, or long-lived `executing` operations.
- Back up the state directory and audit evidence with owner-only access.
- Apply lockfile-reviewed dependency updates and run `npm run verify`.
- Rotate the Discord token periodically and whenever exposure is suspected.

A final live check must use a disposable guild and a disposable target. Mocked gates require no credentials; the live check is intentionally credential-blocked until the operator supplies a token.
