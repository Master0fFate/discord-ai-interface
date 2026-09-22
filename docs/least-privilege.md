# Least-privilege matrix

Grant only permissions needed by policy-enabled operations. Discord hierarchy rules still apply: the bot's highest role must be above a target member's highest role and above any role it manages. Never grant `Administrator`.

| Capability | Discord permission | When needed | Policy controls |
|---|---|---|---|
| Guild/channel/role inspection | View Channels | Read tools (guild metadata is otherwise generally available) | Guild allowlist for mutations; reads use explicit IDs |
| Member inspection | View Channels; access to guild | Planning member actions | `memberIds`, protected member lists |
| Add/remove roles | Manage Roles | `role.add`, `role.remove` | operation, `memberIds`, `roleIds`, protected lists, hierarchy preflight |
| Timeout/untimeout | Moderate Members | `member.timeout`, `member.untimeout` | operation, `memberIds`, protected lists, `maxTimeoutSeconds` |
| Ban/unban/list bans | Ban Members | `member.ban`, `member.unban`, ban inspection | operation, `memberIds`, protected lists, `maxBanDeleteMessageSeconds` |
| Channel overwrite upsert/delete | Manage Roles | `overwrite.upsert`, `overwrite.delete` | operation, `channelIds`, target allowlists/protection, `allowedPermissionBits` |
| Discord audit-log inspection via library adapter | View Audit Log | Only integrations that call the audit-log read | Do not grant unless used |

## Recommended profiles

- **Read-only:** View Channels. Do not enable mutation operations in policy.
- **Role steward:** View Channels + Manage Roles; policy only `role.add`/`role.remove`, with a small role/member allowlist.
- **Moderator:** View Channels + Moderate Members and/or Ban Members; authorize only required actions and conservative limits.
- **Overwrite steward:** View Channels + Manage Roles; allowlist exact channels, targets, and permission bits.

Discord permission decimal values are bitsets. Derive `allowedPermissionBits` from reviewed Discord permission constants and authorize only bits the operator intends to change. `0` allows no nonzero overwrite bits. Do not copy a role's full permissions blindly.

Separate bots are preferable when operator duties differ. This reduces the impact of one token or policy compromise.
