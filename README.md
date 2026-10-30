# Discord conversation plugin for Timon

Talk to a Timon agent from Discord: direct messages and chosen server channels, one mission per day, agent replies and question cards sent back to Discord.

- Plugin id `discord`, `apiVersion` 10, kind `behavior`. No npm dependency, no WebSocket.
- Discord is read over REST by a background poll, always through `ctx.fetch` (`Retry-After` honoured).
- Only one Discord user is obeyed: the configured owner (default: the owner of the configured server). Bots, webhooks, system messages and everyone else are ignored.
- **Polling is off by default** (`pollEnabled`).

## How it works

| Direction | Mechanism |
| --- | --- |
| In | Poll the DM with the owner and the configured channels (one cursor per channel). History is **not** replayed at first start. Messages are handled in arrival order across channels. |
| Conversation | First message of the day: `ctx.missions.spawn` on the configured agent. Following messages: `ctx.missions.send`. The day starts at `rolloverTime` (default 04:00, `timezone` default Europe/Paris). The new day's first message points to the previous mission id. |
| Queue | While a turn is running (tracked from `turn_complete`, and from `turn_in_progress` answers) messages wait in a persistent queue, one is sent per turn, in order. Nothing is lost or sent twice; a message deleted meanwhile is dropped. |
| Out | `ctx.events`: `event` rows (needs `missions:transcript`) carrying assistant text are posted to Discord, split at 2000 characters. The reply goes to the channel the owner wrote in, quoting their message (first part only); otherwise to the DM. A failed turn (`turn_complete` with `failed`) is reported. |
| Questions | `question_pending` posts a card in the DM (numbered options). Answer with a number, `1, 3` on a multi-choice question, free text, or by quoting the card (needed when several are waiting). Several questions in one card: one line each. Start a message with `//` to talk to the agent while a question is waiting. The echo of the plugin's own answer (`question_resolved` with origin `plugin`) is ignored; an answer given in Timon is announced. `kanban_plan` cards are announced but must be validated in Timon. |

State (`ctx.storage.kv`) holds identifiers, cursors and hashes only. Message text lives in Discord and in the mission, never in the plugin's storage; logs carry error kinds, never content, ids of messages or the token. The only route, `GET /status`, requires a signed-in account (`ctx.user()`) and returns counters.

## Install

```sh
timon plugin add ./timon-plugin-discord   # a clone of this repository, or the packed .tgz; unsigned plugins need developer.unsignedPlugins: true
timon plugin list && timon plugin verify discord
```

1. Create a Discord application and bot, enable **Message Content Intent**, invite it to the server with: view channels, send messages (and in threads), read message history, embed links, attach files. No administrator right.
2. Paste the bot token in the plugin's `botToken` setting (a secret field: sealed at rest, never shown back to the browser). Alternative: a vault entry (default name `DISCORD_BOT_TOKEN`) granted to `agent:plugin:discord`; the Secrets page may not offer plugins as a scope, in which case use the setting.
3. Add the operator policy to `timon.config.json` (read when the daemon starts: restart it):

```json
{
  "pluginPolicy": {
    "spawn": { "approved": ["discord"] },
    "http": { "allow": ["discord.com"] }
  }
}
```

`spawn.max` / `spawn.windowMs` can bound the missions started per window; the plugin starts at most one per day plus restarts after a lost mission.

## Settings

| Key | Meaning | Default |
| --- | --- | --- |
| `pollEnabled` | Turn the conversation on (changes apply live, without reload) | `false` |
| `botToken` | Bot token, sealed setting; used first when set | empty |
| `tokenSecret` | Vault entry holding the bot token, used when `botToken` is empty | `DISCORD_BOT_TOKEN` |
| `guildId` | Server id, used to find the owner when `ownerId` is empty | empty |
| `ownerId` | Discord user id allowed to talk to the agent | owner of `guildId` |
| `agent` | Agent that answers | the main agent (see limits) |
| `channels` | Server channel ids to listen to, comma separated; the DM is always on | none |
| `pollSeconds` | Polling interval, minimum 5 | `10` |
| `rolloverTime` | `HH:MM` at which a new daily conversation starts | `04:00` |
| `timezone` | IANA zone of the rollover | `Europe/Paris` |

Example:

```
pollEnabled  true
tokenSecret  DISCORD_BOT_TOKEN
guildId      123456789012345678
agent        assistant
channels     234567890123456789, 345678901234567890
```

Messages written in a channel reach the agent prefixed with `[Discord #channel-name]` and, when they quote a message, a `> excerpt` line (300 characters at most).

## Known limits

- **Global notifications are out of scope.** Timon emits no event when a notification is created, and a background job does not see the notification centre (`ctx.notifications.list` is empty there). Relaying notifications to channels needs another component. *Request to the Timon authors: a "notification created" event delivered to plugins with `notifications:read`.*
- **Main agent default.** A background job only sees the agents the plugin created (`ctx.agents.list`), so the "main agent" default usually cannot be resolved: set `agent` explicitly. Without it, messages are kept and the owner is told.
- **Tool approvals** (Allow / Deny) are not questions in the plugin API and cannot be relayed.
- **Questions** only come from the current and the previous day's mission. Attachments, images and voice messages are ignored; only text is forwarded.
- **Rate limits**: the client waits `Retry-After` (up to three retries). Polling is not real time (`pollSeconds`).
- **Reply routing** relies on transcript rows arriving before `turn_complete`; a late row goes to the DM.
- Two programs polling the same Discord conversation answer twice: stop any other Discord relay before enabling this one.
- **Missions belong to the plugin.** Missions started by the plugin are owned by `plugin:discord`. The user sees them in their missions list and can write in them (verified on Timon 0.1.6), but the agent acts with the plugin's identity: data owned by the user's account (for example their TO DO notebook) answers "not found". *Request to the Timon authors: let a plugin start a mission on behalf of the user who configured it.*
- **Policy is read at daemon start.** `pluginPolicy` changes need a restart of the Timon daemon service; quitting the desktop app does not restart it.
- **Session reuse.** If the configured agent resumes its previous CLI session for new missions, the daily rollover does not give a fresh context; a dedicated agent avoids mixing the Discord conversation with other work.

## Tests

```sh
node --test test/        # no network, Discord and ctx are simulated
```
Covered: owner filtering, no replay at first start, queue during a turn, 2000-character split, reply routing, cards and answers (number, multi-choice, free text, quote, invalid), `//`, echo handling, daily rotation, refused spawn, no content or token in storage and logs.
