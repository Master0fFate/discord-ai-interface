# Threat model

## Security objective

Permit a local trusted operator to perform one explicitly scoped Discord administration action without allowing Discord content, an AI provider, an MCP client, or a stolen proposal to expand or authorize that action.

## Trust boundaries

| Component/data | Trust | Treatment |
|---|---|---|
| Operator at the local TTY | Trusted approver | Must inspect the preview and type the complete action hash |
| Policy/config and local state directory | Trusted, security-sensitive | Restrict OS access; changes require operator review |
| Discord REST responses, names, topics, reasons | Untrusted | Data only; never interpreted as commands |
| Natural-language provider output | Untrusted | Strict action schema, policy check, preview, and separate approval |
| MCP client/model | Untrusted proposer | Fixed tools only; cannot bypass proposal/approval/execution stages |
| Discord bot token and provider API key | Secret | Environment/process manager only; redacted from output |
| Audit JSONL | Security evidence | Append and fsync; execution fails closed if the attempted event cannot be written |

## Threats and controls

- **Prompt/content injection:** Discord text is marked untrusted in MCP results. There is no arbitrary HTTP, route, shell, filesystem, or generic mutation tool. Model output is parsed as one strict typed action.
- **Privilege expansion/confused deputy:** policy is deny-by-default and allowlists guild, operation, immutable target IDs, permission bits, and moderation limits. Discord role hierarchy and bot permissions are checked during planning and again before execution.
- **Name ambiguity/spoofing:** execution uses snowflake IDs. Display names are never an execution authority.
- **Proposal tampering/substitution:** a canonical, key-sorted action is SHA-256 hashed. Confirmation is bound to operation and hash, expires, and is single use. Durable compare-and-swap states prevent duplicate execution.
- **Stale state/TOCTOU:** exact preconditions are persisted, file-store compare-and-swap transitions are cross-process locked, and Discord state is re-fetched before mutation. Cross-process target lock files serialize different operations aimed at the same member or channel; durable CAS also prevents a second process from entering the same operation. Postconditions are verified; ambiguous transport outcomes become `uncertain`.
- **Rate-limit or network storms:** retries are bounded, Discord global/route/bucket limits are honored, delays are capped, and mutation transport failures are treated as potentially uncertain.
- **Credential disclosure:** secrets are not accepted as command arguments or config fields. Error bodies are not retained; structured output recursively redacts secret-like fields and registered secret values.
- **Audit/state loss:** files are created with owner-only mode where supported; state updates use atomic replacement; audit records are append-only and fsynced. Approval, recovery, and reconciliation write a request event before CAS and a result event after it, so races do not create competing authoritative outcomes. `operations.json` remains the workflow source of truth if a crash occurs between files. Backups and filesystem integrity remain operator responsibilities.
- **Local compromise:** out of scope. A user able to alter policy/state or inspect the bot process can act with the bot's authority. Use a dedicated OS account and encrypted disk.
- **Discord/API or dependency compromise:** out of scope for complete prevention. Pin installs with `npm ci`, review lockfile changes, run `npm audit`, and rotate tokens after suspected exposure.

## Residual limitations

Target locks and file-store transitions use short cross-process lock files and fail closed under contention. A process crash can leave a `.lock` file that requires operator inspection and removal after confirming no process still owns the data directory. A crash after Discord accepts a mutation but before verification can leave `executing`; treat it as uncertain and recover manually. Audit JSONL is not cryptographically chained or remote/WORM storage. Discord remains the source of truth.
