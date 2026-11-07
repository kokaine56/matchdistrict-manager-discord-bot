# Project Context: MatchDistrict Manager Discord Bot

## 1. Project Overview & Architecture
* **Project Name**: `matchdistrict-manager-discord-bot`
* **Purpose**: Discord community automation, member moderation, automated audit logging, support ticketing, and full lifecycle esports tournament operations.
* **Runtime**: Node.js (>= 18.0.0, `"type": "module"`)
* **Primary Frameworks**: `discord.js` v14.18.0, `mongodb` v7.7.0, `dotenv` v16.4.7
* **Entry Point**: [`index.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/index.js)
* **Test Runner**: Node.js built-in test runner (`node:test`)

### Directory Structure
```
matchdistrict-manager-discord-bot/
├── AGENTS.md                          # Project-specific AI agent instructions
├── PROJECT_CONTEXT.md                 # Persistent architectural memory & service catalog
├── index.js                           # Bot client initialization, gateway events, HTTP health-check
├── tournamentService.js               # Tournament channels, control panels, round management, results
├── configurableTournamentService.js   # Interactive tournament setup wizard & channel provisioning
├── configurableRegistrationService.js # Interactive registration workflows & roster allocation
├── configurableTournamentData.js      # Data structures, schemas, and in-memory caches
├── registrationScheduler.js           # Timed scheduling for registration opens/closes
├── mongoService.js                    # MongoDB connection pool, collections, and state persistence
├── auditLogger.js                     # Centralized Discord audit event handlers & secret redaction
├── ticketService.js                   # Interactive support ticket panels and channel lifecycles
├── moderationService.js               # Moderation actions (.ban, .mute, .unmute, .clear, profanity filter)
├── badWordsConfig.js                  # Profanity dictionary and keyword configurations
├── announcementService.js             # Formatted announcement creation & dispatch
├── memberCacheService.js              # In-memory cached guild member directory
├── slotChartService.js                # Roster and slot chart formatting
├── teamEnrollmentService.js           # Team verification and roster synchronization
├── guildSettings.json                 # Local guild configuration cache / fallback
├── bot/discord/features/
│   └── inviteCampaign/                # Modular invite tracking, milestones, and leaderboard feature
└── test/                              # Comprehensive test suites run via node:test
```

---

## 2. Core Modules & Responsibilities

| Module | Primary Responsibility |
| :--- | :--- |
| [`index.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/index.js) | Client bootstrap, intent configuration, message/interaction routers, HTTP keep-alive server on `PORT`. |
| [`tournamentService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/tournamentService.js) | Full tournament lifecycle: category/channel creation, control panel embeds, round advancement, result submission modals, screenshot attachments, admin score approval/rejection, team qualification. |
| [`configurableTournamentService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/configurableTournamentService.js) | Setup wizard for custom tournaments, slot count configuration, role creation, and automated permission sets. |
| [`configurableRegistrationService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/configurableRegistrationService.js) | Player/team registration modals, verification code parsing, slot filling, and schedule broadcasts. |
| [`registrationScheduler.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/registrationScheduler.js) | Background cron-like scheduler handling automated stage transitions and registration windows. |
| [`mongoService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/mongoService.js) | MongoDB connection handling, collections (`tournaments`, `guildSettings`, `managedMessages`), and schema synchronization. |
| [`auditLogger.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/auditLogger.js) | Detailed logging for channel/role/member changes, message edits/deletions, with automatic secret/token redaction. |
| [`ticketService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/ticketService.js) | Private support channel creation, buttons, modals, transcript archiving, and channel cleanup. |
| [`moderationService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/moderationService.js) | Moderation command handlers (`.ban`, `.mute`, `.unmute`, `.clear`) and real-time profanity filtering. |
| [`bot/discord/features/inviteCampaign/`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/bot/discord/features/inviteCampaign) | Tracks member invite attribution, invite link creation/deletion, leaderboards, and milestone roles. |

---

## 3. Discord Functionality & Commands

### Command Interface (Prefix: `.`)
* **Server Setup & Config**:
  * `.setup`: Provisions private audit channels (`#bot-log`, `#member-log`, `#dm-log`, `#msg-log`, `#ban-unban-log`) and voice member count channel.
  * `.setup remove`, `.setup confirm`, `.setup cancel`: Safe 30-second confirmation flow for channel teardown.
  * `.member count <text>`: Customizes member count voice channel name prefix.
  * `.dm welcome on / off`: Toggles automated direct onboarding messages to new members.
* **Moderation & Administrative**:
  * `.ban @user [reason]`: Bans member with role hierarchy checks and audit channel logging.
  * `.mute @user <minutes>`: Applies Discord native timeout.
  * `.unmute @user`: Removes Discord timeout.
  * `.clear <1-100>`: Bulk-deletes messages (respects 14-day Discord limitation, excludes audit channels).
* **Support & Announcements**:
  * `.ticket setup`: Installs interactive support ticket creation panel.
  * `.annc setup`: Configures announcements publishing channel.
* **Tournament & Dashboard**:
  * `.dash`: Opens interactive tournament control dashboard.
  * `.website`: Posts official MatchDistrict platform URL.
  * `.ping` / `.status` / `.help`: Diagnostic and guidance commands.

### Interactive Components & Modals
* **Tournament Control Panel**: Button components to open/close registrations, view rounds, publish room credentials, allocate slots, and qualify teams.
* **Result Submissions**: Players submit match end screenshots and scores via Discord modals and attachments. Admins approve/reject directly via button rows in private result review channels.
* **Organizer Verification**: Prompts organizers to verify ownership via temporary verification code linking Discord server to MatchDistrict website organizer profile.

---

## 4. Database & Persistence Layer
* **Driver**: Official `mongodb` client (v7.7.0).
* **Connection**: Managed via `initMongo(uri, dbName)` in `mongoService.js`.
* **Primary Collections**:
  * `tournaments`: Stores bot-managed tournament metadata, channel IDs, categories, rounds, and group allocations.
  * `guildSettings`: Guild-level preferences (log channels, welcome DM flags, prefixes, ticket settings).
  * `managedMessages`: Tracks persistent bot messages (control panels, ticket panels, rosters) across restarts.
* **Dual-Layer Sync**:
  * Falls back to / syncs with `guildSettings.json` when MongoDB is temporarily disconnected.
  * `migrateJsonToMongo()` utility for migrating local state into cloud MongoDB.

---

## 5. Integrations & External Services
* **MatchDistrict Website API**:
  * Communicates via `MATCHDISTRICT_API_URL`.
  * Authenticates using shared secret `MATCHDISTRICT_BOT_SECRET`.
  * Verifies organizer linking codes and queries user registration eligibility.
* **Discord Gateway**:
  * Privileged Gateway Intents required: `GuildMembers`, `MessageContent`, `Guilds`, `GuildMessages`, `GuildMessageReactions`, `DirectMessages`.
* **Container Health-Check**:
  * Built-in HTTP server listening on `PORT` (or 8080) responding with `200 OK` for cloud hosting platforms (Render, Railway, Fly.io).

---

## 6. Environment Variables (Reference Names Only)
* `DISCORD_BOT_TOKEN`: Discord Bot secret authentication token.
* `MATCHDISTRICT_API_URL`: Base URL for the MatchDistrict website backend API.
* `MATCHDISTRICT_BOT_SECRET`: Shared secret key for authenticating website-to-bot and bot-to-website requests.
* `MATCHDISTRICT_GUILD_ID`: Default / official Discord guild ID.
* `MONGODB_URI`: MongoDB connection string.
* `MONGODB_DB_NAME`: Database name for storing bot collections.
* `PORT`: HTTP port for container health checks (default: 8080).

---

## 7. Verification & Test Suite
Tests are located in `test/` and run natively with `node --test`:
* `test/bot.test.js`: Core bot startup, configuration, and intent tests.
* `test/tournament.test.js` & `test/configurableTournament.test.js`: Channel provisioning, round progressions, group allocations.
* `test/inviteCampaign.test.js`: Invite tracking, milestone roles, and leaderboard calculations.
* `test/moderation.test.js` & `test/ticket.test.js`: Moderation commands and support ticket lifecycles.
* `test/mongo_conflict.test.js` & `test/keepAliveServer.test.js`: Database concurrency and HTTP health server.

