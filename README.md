# Clash of Clans War Reminder Bot

A Discord bot that monitors your clan's wars via the Clash of Clans API and sends automatic attack reminders so nobody forgets to use their hits.

## Features

**Automatic Reminders**
- Detects new wars and announces preparation day + battle day start
- Sends countdown reminders at configurable thresholds (12h, 6h, 4h, 2h, 1h before war ends)
- @mentions linked players who haven't used their attacks
- Posts a summary with the final result and missed attacks when the war ends
- Skips reminders when the war outcome is already mathematically decided
- Records every ended war so `/missed` can show who skips attacks over time

**Clan War League (CWL)**
- Tracks CWL rounds with the same announcement/reminder lifecycle
- `/cwl-check` — see who still needs to attack in the current CWL round
- `/cwl-standings` — view the ranked standings of all 8 clans in the group
- `/cwl-stats` — per-player CWL performance across all rounds

**Raid Weekend (Clan Capital)**
- Announces the start, reminds players who started raiding but have attacks left (24h and 4h before the end by default), posts loot + top raiders when it ends
- `/raid-check` — see who started raiding but still has attacks left

**Slash Commands**
| Command | Description |
|---------|-------------|
| `/war-check` | Check current war status and who needs to attack |
| `/cwl-check` | Check current CWL round status |
| `/cwl-standings` | CWL group standings (all 8 clans) |
| `/cwl-stats` | Per-player CWL stats across all rounds |
| `/link <player> <discord_user>` | Link a CoC player to a Discord account for @mentions |
| `/links` | Show all linked players |
| `/clan-stats` | Clan level, war record, member count, league |
| `/player-stats <player>` | Player profile + current war performance |
| `/war-log [count]` | Recent war results (1-10, default 5) |
| `/missed [days]` | Players ranked by missed attacks, wars + CWL (default 30 days) |
| `/raid-check` | Raid weekend status and who has raid attacks left |
| `/bedtime <time> <timezone>` | Set a personal bedtime reminder (e.g. `/bedtime 23:00 Europe/Paris`) |
| `/bedtime-clear` | Remove your bedtime reminder |
| `/help` | Show all commands |

**Bedtime Reminders**
- Players can set a personal bedtime with `/bedtime`, using a time zone like `Europe/Paris` (follows summer/winter time) or a fixed offset like `+2`
- If a war is active and they still have attacks left, the bot pings them ~30 minutes before bedtime

## Architecture

```
coc_discord_bot.js    ← Entry point: starts the Discord bot
coc_test.js           ← CLI tool: test CoC API without Discord
config.js             ← All configuration and secrets (gitignored)
coc_api.js            ← CoC REST API wrapper (one function per endpoint)
war_analysis.js       ← Pure war logic: scoreboard, "is war decided?", reminder rules
cwl_api.js            ← CWL orchestration: finds our war across rounds
cwl_analysis.js       ← CWL analysis: standings, per-player stats
discord_messages.js   ← All Discord message formatting (markdown builders)
commands.js           ← Slash command definitions, registration, handlers
scheduler.js          ← Auto war check timer, CWL check, bedtime check, anti-spam
persistence.js        ← Read/write JSON data files (player links, bedtimes, spam guard, war history)
test.js               ← Self-check of the pure logic: node test.js
```

**Data files** (created at runtime, gitignored):
- `player_map.json` — CoC player tag → Discord user ID
- `bedtime_map.json` — Discord user ID → bedtime settings
- `spam_guard.json` — Anti-spam state so restarts don't cause duplicate messages
- `war_history.json` — Missed attacks per player for every ended war (used by `/missed`)

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or later
- A [Clash of Clans API token](https://developer.clashofclans.com) (IP-locked to your server)
- A [Discord bot application](https://discord.com/developers/applications) with the `bot` scope and `applications.commands` permission, plus **Send Messages** and **Embed Links** in the reminder channel (messages are sent as embeds)

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO

# Install dependencies
npm install

# Create your config file from the template
cp config.example.js config.js
# Then edit config.js with your API tokens, clan tag, and Discord IDs
```

### Running

```bash
# Start the Discord bot
node coc_discord_bot.js

# Or test the CoC API connection without Discord
node coc_test.js
```

## How the Reminder Logic Works

A player needs a reminder if:
- **0 attacks used** — they haven't attacked at all
- **1 attack used, no 3-star** — they can still improve with their second hit

A player does NOT get reminded if:
- **1 attack used with a 3-star** — great hit, save the second for cleanup
- **2 attacks used** — nothing left to do

The bot also checks if the war is **mathematically decided** (neither side can change the outcome with remaining attacks) and skips reminders in that case.

## Anti-Spam

Each message type (prep announcement, battle day start, countdown threshold, war-ended summary, raid announcements) fires **exactly once per war**. State is persisted to `spam_guard.json` using atomic writes so a bot restart mid-war won't cause duplicate messages.
