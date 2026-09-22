# Verification and release checklist

Run from a clean checkout with Node.js 22.12+:

```sh
npm ci
npm run verify
```

`verify` runs lint, strict typecheck, the full mocked suite (including CLI/MCP and adversarial security tests), production build, dedicated CLI/MCP smoke tests, and a high-severity dependency audit. A passing audit currently means npm reports zero known vulnerabilities; also review lockfile changes and upstream advisories.

## Manual stdio smoke

With configuration and token supplied through the environment, start `node dist/mcp.js` and send one JSON object per line:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Confirm valid JSON-RPC responses, a fixed narrow tool list, and no credentials on stdout/stderr.

## Credential-blocked live test

Only this gate needs external credentials. Use a disposable guild, bot, role, member, and narrow policy:

1. Run status and read commands; verify immutable IDs.
2. Propose a harmless reversible role addition, inspect the entire preview, approve at a TTY, and execute.
3. Verify Discord state and both Discord/local audit evidence.
4. Send one approved embed message with `message.send` and confirm the operation reports `succeeded`, not `uncertain`; postcondition verification matches the message by its 25-character wire nonce.
5. Propose and execute role removal to restore state.
6. Remove the bot from the guild or rotate/delete the disposable token.

Never run a first live test in a production guild. Record the test date, commit, Node version, bot ID (not token), operation IDs, and result.
