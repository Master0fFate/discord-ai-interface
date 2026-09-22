# Policy and operation examples

The shipped [`discord-ai.policy.example.json`](../discord-ai.policy.example.json) is deny-by-default. IDs below are placeholders; use Discord snowflakes as strings.

## Narrow role steward policy

```json
{
  "guilds": {
    "10000000000000000": {
      "operations": ["role.add", "role.remove"],
      "roleIds": ["20000000000000000"],
      "channelIds": [],
      "memberIds": ["30000000000000000"],
      "protectedMemberIds": ["40000000000000000"],
      "protectedRoleIds": ["50000000000000000"],
      "allowedPermissionBits": "0",
      "maxTimeoutSeconds": 3600,
      "maxBanDeleteMessageSeconds": 0
    }
  },
  "protectedMemberIds": [],
  "protectedRoleIds": []
}
```

Global protected lists apply to every guild entry; per-guild lists add local protection. Targets must be positively allowlisted even when an operation is enabled.

## Proposals

```sh
discord-ai-interface propose --action-json '{"type":"role.add","guildId":"10000000000000000","memberId":"30000000000000000","roleId":"20000000000000000","reason":"Ticket 1842: support rotation"}'

discord-ai-interface propose --action-json '{"type":"member.timeout","guildId":"10000000000000000","memberId":"30000000000000000","until":"2026-06-01T12:30:00.000Z","reason":"Moderator incident 92"}'

discord-ai-interface propose --action-json '{"type":"overwrite.upsert","guildId":"10000000000000000","channelId":"60000000000000000","targetId":"20000000000000000","targetType":"role","allow":"1024","deny":"0","reason":"Permit reviewed channel visibility"}'
```

The relevant operation, IDs, timeout/delete limits, channels, targets, and permission bits must all be allowed by policy. JSON schemas reject unknown fields, overlapping allow/deny bits, malformed IDs, and noncanonical unsigned permission strings.

If shell quoting is error-prone, construct and quote the `--action-json` value with trusted local tooling; the CLI does not currently accept an action file. Never place tokens in action JSON or reasons. Reasons are sent to Discord's audit log and should contain a ticket/reference, not personal secrets.
