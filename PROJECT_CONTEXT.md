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
├── threadManagementService.js         # Channel thread permission controls (.remove threads)
├── badWordsConfig.js                  # Profanity dictionary and keyword configurations
├── announcementService.js             # Formatted announcement creation & dispatch
├── welcomeService.js                  # Dynamic personalized welcome DM resolver & generator
├── memberCacheService.js              # In-memory cached guild member directory
├── slotChartService.js                # Roster and slot chart formatting
├── teamEnrollmentService.js           # Team verification and roster synchronization
├── guildSettings.json                 # Local guild configuration cache / fallback
├── bot/discord/features/
│   ├── arena/                         # 1v1 BGMI TDM matchmaking and lifecycle
│   ├── inviteCampaign/                # Modular invite tracking, milestones, and leaderboard feature
│   └── rolePrefix/                    # Server-specific role nickname prefix management (.role pre)
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
| [`bot/discord/features/inviteCampaign/`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/bot/discord/features/inviteCampaign) | Persistent Invite & Earn panel displays configured prize amounts from the campaign `rewards` array in rank order, or a dedicated poster announcement image when configured; admins can edit prizes and set/replace/remove campaign posters (`.invite poster` / `.invite poster remove`), and panel updates edit the stored message in place. The Create Link response shows the successful count above an emoji-enhanced promo containing the campaign name and user's saved invite link, with no response buttons. |
| [`moderationService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/moderationService.js) | Moderation command handlers (`.ban`, `.mute`, `.unmute`, `.clear`) and real-time profanity filtering. |
| [`threadManagementService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/threadManagementService.js) | Channel thread permission management (`.remove threads`), applying explicit `CreatePublicThreads` and `CreatePrivateThreads` denies while preserving all message and media permissions. |
| [`welcomeService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/welcomeService.js) | Dynamic personalized welcome DM generation on member join (`handleGuildMemberAdd`). Dynamically queries MongoDB and active memory caches for active invite campaigns (`status === 'Active'`), open tournament registrations (`status === 'OPEN'`), and guild essential channels (`#rules`, `#find-a-team`, `#general-chat`), automatically adjusting sections with direct clickable Discord channel links and graceful fallbacks. |
| [`bot/discord/features/inviteCampaign/`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/bot/discord/features/inviteCampaign) | Tracks member invite attribution, invite link creation/deletion, mobile-readable high-resolution leaderboard images with participant Discord avatars, immediate `deferUpdate()` interaction acknowledgement, and milestone roles. Displays all active inviters on the leaderboard sorted by successful invites descending with deterministic tie-breaking. Renders conditional Winning Amounts: cells remain completely blank (no `₹0`, no `Pending`, no placeholders) for participants below the minimum invite threshold or outside configured prize positions; prize amounts dynamically appear when crossing threshold into prize positions, and are immediately removed if a participant drops below threshold (e.g. member leaves). Debounced auto-updates refresh the leaderboard announcement message as invite counts change. |
| [`bot/discord/features/arena/`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/bot/discord/features/arena) | 1v1 TDM: Free BGMI TDM 1v1 matchmaking managed entirely via Discord and MongoDB. Handles player BGMI details, atomic challenge creation and acceptance, category overflow, Room Maker claims and release, private match channels, room credential dispatch, winner submission, result confirmations/disputes, and automated scheduler timeouts. |
| [`bot/discord/features/rolePrefix/`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/bot/discord/features/rolePrefix) | Server-Specific Role Nickname Prefix system (`.role pre <prefix>`, `.role pre list`, `.role pre remove`, `.role pre refresh`). Formats nicknames using exact unspaced `PREFIX + NICKNAME` (e.g. `DSxKOKAINE`, `DSxFARHAN`). Strictly checks role membership (never prefixes members without the role), prevents stacking/loops, reverts only managed prefixes on role loss, respects Discord role hierarchy / server owner restrictions with graceful skipping and summary reporting, and processes updates through `discordQueue`. |
| [`helpService.js`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/helpService.js) | Central command directory & interactive `.help` system. Organizes all bot commands across 8 structured categories with permission-based visibility (regular members vs admins), dark Match District `#F97316` orange-accent embeds, field chunking to respect Discord's 1024-character limit, interactive pagination buttons, category filter dropdowns working across bot restarts via stateless customIds, and backwards-compatible string fallback. |

---

## 3. Discord Functionality & Commands

### Command Interface (Prefix: `.`)
* **Server Setup & Config**:
  * `.setup`: Provisions private audit channels (`#bot-log`, `#member-log`, `#dm-log`, `#msg-log`, `#ban-unban-log`) and voice member count channel.
  * `.setup remove`, `.setup confirm`, `.setup cancel`: Safe 30-second confirmation flow for channel teardown.
  * `.member count <text>`: Customizes member count voice channel name prefix.
  * `.dm welcome on / off`: Toggles automated direct onboarding messages to new members. When enabled, new member joins receive a personalized welcome DM dynamically resolving currently active invite campaigns (`status === 'Active'`), open tournament registrations (`status === 'OPEN'`), and essential server channels (`#rules`, `#find-a-team`, `#general-chat`) with direct clickable Discord channel links and graceful fallbacks. If no invite event is running or no tournament registration is open, the respective sections are cleanly omitted without empty placeholders. Closed user DMs (`code: 50007`) are handled silently and logged to audit channels.
* **Moderation & Administrative**:
  * `.invite min <number>`: Admin-only positive whole-number minimum successful invite threshold for the current campaign; persists to MongoDB and recalculates qualification.
  * `.invite poster`: Admin-only command accepting image attachments (JPG, JPEG, PNG, WEBP) to set or replace the persistent campaign announcement poster. When set, replaces the text embed with the poster and positions the Create Link button directly below.
  * `.invite poster remove`: Removes the configured poster and restores the original text-based announcement embed on the panel.
  * `.ban @user [reason]`: Bans member with role hierarchy checks and audit channel logging.
  * `.mute @user <minutes>`: Applies Discord native timeout.
  * `.unmute @user`: Removes Discord timeout.
  * `.clear <1-100>`: Bulk-deletes messages (respects 14-day Discord limitation, excludes audit channels).
  * `.remove threads`: Admin-only command to explicitly disable public and private thread creation (`CreatePublicThreads: false`, `CreatePrivateThreads: false`) for `@everyone` and ordinary member roles in the current channel while preserving all message, media, and button permissions.
  * `.role pre <prefix>`: Admin-only command to configure a server-specific nickname prefix for a role using exact unspaced format `PREFIX + NICKNAME` (e.g. `DSxKOKAINE`). Interactive setup with `RoleSelectMenuBuilder` (or role mention), displaying a confirmation embed with server name, target role mention, and prefix before saving to MongoDB and applying to existing role members with role hierarchy skips.
  * `.role pre list`: Lists all configured role prefixes in the server sorted by role hierarchy position.
  * `.role pre remove [role]`: Removes a role's prefix configuration (interactive select menu or mention) and automatically reverts managed prefixes on member nicknames.
  * `.role pre refresh`: Reapplies all active configured role prefixes across eligible server members through the rate-limited queue, reporting detailed summary metrics.
* **Support & Announcements**:
  * `.ticket setup`: Installs interactive support ticket creation panel.
  * `.annc setup`: Configures announcements publishing channel.
* **1v1 TDM System**:
  * `.tdm setup` (alias `.arena setup`): Admin-only idempotent provisioning of the 1v1 TDM categories (`1V1 TDM`), channels (including public `#room-maker-panel`), and persistent panels without requiring or creating a Room Maker role.
  * `.tdm delete` (alias `.arena delete`): Admin-only command that completely tears down all 1v1 TDM Discord channels (`#create-challenge`, `#available-challenges`, `#room-maker-panel`, `#match-results`, `#challenge-support`, `#evidence`, match channels), categories (`1V1 TDM*`), active timers, and purges all TDM database documents (`arena_config`, `arena_challenges`, `arena_matches`, `arena_disputes`, `arena_logs`, `arena_players`, `arena_volunteers`). Safe to re-run `.tdm setup` cleanly afterwards.
  * `.tdm active` (alias `.arena active`): Lists open challenges and active in-progress matches.
  * `.tdm matches [status]` (alias `.arena matches`): Lists matches with optional status filter.
  * `.tdm cancel <id> <reason>` (alias `.arena cancel`): Cancels match/challenge in any non-terminal state.
  * `.tdm reassign <id> @roommaker` (alias `.arena reassign`): Reassigns match to another Room Maker without granting Room Maker access to challengers' channel.
  * `.tdm dispute` (alias `.arena dispute`): Lists open disputes.
  * `.tdm result <id> <A|B> <reason>` (alias `.arena result`): Resolves a disputed match and completes it (displays BGMI IGN).
  * `.tdm roommaker add|remove @user` (alias `.arena roommaker`): Registers or sets availability status for a Room Maker profile.
  * `.tdm roommaker limit <n>` (alias `.arena roommaker limit`): Configures Room Maker concurrent match limit (default 1).
  * `.tdm suspend|unsuspend @player` (alias `.arena suspend`): Manages player suspension status.
  * `.tdm resetuid @player` (alias `.arena resetuid`): Clears player's registered BGMI details.
  * `.tdm stats` (alias `.arena stats`): Overview of TDM match and dispute metrics.
  * `.tdm logs [id]` (alias `.arena logs`): Audit logs for TDM actions.
  * `.roommaker profile` (alias `.volunteer profile`): Displays Room Maker profile, match counts, and availability for any server member.
  * `.roommaker status` (alias `.volunteer status`): Toggles availability status (`AVAILABLE` / `UNAVAILABLE`) for any server member.
  * `.mymatches`: Lists active matches assigned to the Room Maker for any server member.
  * `.leave <matchId>` (alias `.release <matchId>`): Leaves assigned match before submitting credentials with confirmation; resets match to WAITING_FOR_VOLUNTEER, and decrements active matches. Blocked once room credentials have been submitted.
  * **1V1 TDM Channel Naming Convention**:
    * Category: `1V1 TDM`
    * Public channels: `1v1-tdm-info`, `1v1-tdm-create`, `1v1-tdm-available-matches`, `1v1-tdm-room-maker-panel`, `1v1-tdm-match-results`, `1v1-tdm-match-support`.
    * Admin channel: `1v1-tdm-evidence`.
    * Dynamic private channels: `1v1-tdm-match-0001`, `1v1-tdm-roommaker-0001` (consistent lowercase ASCII format with single hyphens matching public channels).
    * **Independent Dual Screenshot Delivery**: Winner proof screenshot submitted by Room Maker is uploaded as two separate native Discord attachments: one to `1v1-tdm-evidence` with match ID, winner BGMI IGN, and Room Maker identity for staff audit; and another directly to `1v1-tdm-match-XXXX` with a clean verification embed and Confirm/Dispute buttons. Players view the screenshot without requiring access to the admin evidence channel.
    * **Strict Control Separation**: Room Maker controls (`Submit Room Details`, `Edit Room Details`, `Start Match`, `Submit Winner`, `Leave Match`) exist exclusively on the Room Maker dashboard in `1v1-tdm-roommaker-XXXX`. Challengers channel `1v1-tdm-match-XXXX` contains only player-facing images, room credentials, incorrect credential reports, result screenshots, and confirmation/dispute buttons, enforced by both UI component separation and interaction permission validation.
    * **Automatic & Idempotent Migration**: Existing channels (found by MongoDB ID, double-hyphen variants like `1v1-tdm--info`, or legacy aliases) are reused and renamed to single-hyphen specs (`1v1-tdm-<slug>`) without creating duplicates or altering permissions.
  * **Online Member Notifications (`@here`) & Automated Cleanup**:
    * **Simplified Notification Format**: Free of channel mentions:
      * Challenge Creation: `@here A new BGMI TDM 1V1 challenge is available! Accept the challenge now!`
      * Room Maker Needed: `@here A BGMI TDM 1V1 match needs a Room Maker! Claim an available match now!`
    * **Atomic Tracking & Persistence**: Message IDs and channel IDs are stored in MongoDB (`notificationMessageId`, `roomMakerNotificationMessageId`, `challengeNotificationMessageId`) and local cache to guarantee strictly once delivery and accurate targeting.
    * **Automatic Notification Deletion Lifecycle**:
      * **Challenge Accepted / Cancelled / Expired**: Corresponding challenge notification message in `1v1-tdm-available-matches` is deleted immediately.
      * **Match Claimed by Room Maker**: Corresponding Room Maker availability notification in `1v1-tdm-room-maker-panel` is deleted immediately.
      * **Room Maker Leaves Match**: Deletes old availability notification and allows a fresh notification upon re-entering `WAITING_FOR_VOLUNTEER`.
      * **Match Completed / Cancelled**: Ensures both Challenge and Room Maker notifications are deleted if not already removed.
      * **Startup Reconciliation**: Scans and sweeps lingering notifications for expired challenges or terminal matches.
    * **Graceful Permissions & Safety**: Uses `queueMessageDelete` handling Discord error code `10008` (Unknown Message) without throwing errors, and handles missing `MentionEveryone` permission gracefully with warnings without disrupting workflows.
  * **Challenge Image Cleanup & Lifecycle Deletions**:
    * When a challenge expires after 30 minutes, updates status to `EXPIRED` in MongoDB and permanently deletes the message (image + buttons) from `1v1-tdm-available-matches`.
    * Applies identical deletion cleanup when a challenge is cancelled by the creator or successfully accepted into a match.
    * Startup recovery (`recoverArenaOnStartup`) sweeps MongoDB for expired open challenges, sets them to `EXPIRED`, and deletes lingering challenge messages from Discord.
  * **Permanent TDM Information Channel (`1v1-tdm-info`)**:
    * Visible to all server members, read-only for `@everyone`, thread creation disabled.
    * Sends a clean, permanent Match District dark theme embed (`#F97316`) titled `MATCH DISTRICT – 1V1 TDM` detailing the 7-step match flow and fair play rules.
    * Uses dynamic Discord channel mentions (`<#CREATE_CHALLENGE_CHANNEL_ID>`, etc.) hydrated directly from MongoDB config.
    * Idempotent management: `infoMessageId` is stored in `arena_config` and edited in place on subsequent setups rather than duplicated.
  * **Complete Privacy Separation (Challengers vs Room Maker Channels)**:
    * **Challengers' Channel (`𝟏𝐕𝟏 𝐓𝐃𝐌｜match-0001`)**: Accessible ONLY to Player A, Player B, Admins, and Bot. Room Maker has **ZERO ACCESS** and no permission overwrites at all times, including during screenshot and dispute review.
    * **Room Maker's Channel (`𝟏𝐕𝟏 𝐓𝐃𝐌｜roommaker-0001`)**: Accessible ONLY to assigned Room Maker, Admins, and Bot. Players are strictly excluded.
    * **Automated Proof Forwarding**: When the Room Maker uploads the scoreboard screenshot, the bot validates it, persists metadata in MongoDB, posts a copy to admin `#evidence`, posts a copy to `match-0001` with Confirm/Dispute buttons, and never touches permissions on `match-0001`.
  * **Room Maker Panel Auto-Cleanup**:
    * When a match reaches `COMPLETED`, its match card image/message in `#room-maker-panel` is deleted immediately and `panelMessageId` is cleared in MongoDB.
    * Active match cards remain in the panel.
    * Bot startup recovery (`recoverArenaOnStartup`) scans and deletes any lingering completed match cards if completed while offline.
  * **Room Maker Privacy & Permission Enforcement**:
    * **Strictly Hidden Identity**: The Room Maker's identity (mention, username, avatar) is never exposed in `𝟏𝐕𝟏｜match-0001` or on player-visible match/result images. The bot acts as an intermediary for all announcements ("A Room Maker has been assigned to your match", "Room credentials have been updated by the Room Maker").
    * **Default Read-Only Permissions**: Inside `𝟏𝐕𝟏｜roommaker-0001`, the Room Maker can view channel and read message history, but `SendMessages: false`, `AttachFiles: false`, and all thread creation permissions are denied.
    * **Temporary 5-Minute Proof Upload Window**: When the Room Maker clicks "Submit Winner", message sending and attachment permissions are temporarily granted for 5 minutes to allow uploading the scoreboard screenshot; permissions are immediately revoked upon screenshot receipt or timeout.
  * **Dashboard-Only Room Maker Channel**:
    * `𝟏𝐕𝟏｜roommaker-0001` contains ONLY the single managed match image card dashboard and its action buttons.
    * All secondary standalone messages (`rmNotice`, `rmAlert`, `uploadEmbed`, `confirmNotice`, `leaveNotice`) are eliminated; all status updates and guidance are embedded within the dashboard description or delivered via ephemeral interaction replies.
    * Automatic background cleanup (`purgeStandaloneRoomMakerMessages`) purges any stray bot messages during lifecycle transitions or bot startup.
  * **Standardized Match ID & Credential Formatting**:
    * **Match ID**: Single consistent format everywhere: `MD-0001`, `MD-0002` (4-digit zero-padded number with `MD-` prefix across database, images, embeds, modals, support messages).
    * **Room Credentials Embed**: Exact labels `Match ID`, `Room ID`, `Room Password` without backticks (clean readable text).
  * **Leave Match & Credential Replacement Lifecycle**:
    * **Pre-Credentials Leave**: Room Maker can leave before submitting room details (`Leave Match` button present, resets match to `WAITING_FOR_VOLUNTEER`).
    * **Post-Credentials Lockout**: Once valid Room ID and Room Password are submitted (`ROOM_READY`), the `Leave Match` button is removed from the dashboard, and attempts to leave are rejected; only admins can reassign or release.
    * **Credential Replacement Flow**: When a player clicks "Report Incorrect ID/Password", match enters `ROOM_ISSUE` (locking match start) and Room Maker sees "Edit Room Details". Upon submitting corrected credentials, the bot deletes the old credentials message from the challengers channel, posts a fresh credentials embed with the report button, and posts a clean update embed notifying players without tagging or exposing the Room Maker.
  * **Clean Embed-Based UI**: Replaced raw text blocks with Match District branded dark-theme embeds (`#F97316` orange accent) across both private channels for room credentials, status transitions, reminders, and verification prompts.
  * **Locked Channel Thread Restrictions**: Denies `CreatePublicThreads`, `CreatePrivateThreads`, and `SendMessagesInThreads` to `@everyone` on `#create-challenge`, `#available-challenges`, `#room-maker-panel`, `#match-results`, `#arena-evidence`, and the arena category.
  * **Persistent Dashboard Bottom-Positioning**: Both `#available-challenges` and `#room-maker-panel` keep their interactive image card and controls pinned at the bottom. If other messages (such as scheduler alerts or reminders) arrive above the dashboard, it is automatically repositioned to the bottom, deleting the previous message after the replacement is created and updating the stored message ID in MongoDB. If already at the bottom, it edits in place.
  * **Dynamic Image-Based Match & Result Cards**: High-performance SVG-to-PNG rendering powered by `@resvg/resvg-js` using **bundled fonts only** (`bot/discord/features/arena/assets/fonts/`: Noto Sans + Noto Sans Devanagari, Regular/Bold; `loadSystemFonts: false`). Generates official esports match cards (800x420) and result cards. Features larger avatars (84px diameter), 20px bold display names, grapheme-safe Unicode/Devanagari text segmentation (`Intl.Segmenter`) for Hindi IGNs (`ताजKOKAINE`), dynamic IGN font scaling on dedicated text lines, enlarged 44px VS center element, and removal of Room Maker details from public images.
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
  * `arena_players`, `arena_challenges`, `arena_matches`, `arena_volunteers`, `arena_disputes`, `arena_logs`, `arena_config`: Stores 1v1 Challenge Arena state, player profiles, match credentials, volunteer statistics, disputes, and audit trails.
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
* `test/arena.test.js`: 1v1 Challenge Arena lifecycle, public volunteer panel, atomic claiming concurrency, modals, and scheduler tests.
* `test/bot.test.js`: Core bot startup, configuration, and intent tests.
* `test/tournament.test.js` & `test/configurableTournament.test.js`: Channel provisioning, round progressions, group allocations.
* `test/inviteCampaign.test.js`: Invite tracking, milestone roles, and leaderboard calculations.
* `test/moderation.test.js` & `test/ticket.test.js`: Moderation commands and support ticket lifecycles.
* `test/removeThreads.test.js`: Channel thread removal command, administrator enforcement, permission preservation, and idempotency tests.
* `test/rolePrefix.test.js`: Server-specific role nickname prefix configuration, wizard flows, automatic sync, hierarchy handling, and priority resolution.
* `test/help.test.js`: Complete command directory inspection, permission-based category visibility, interactive pagination, and backwards compatibility.
* `test/mongo_conflict.test.js` & `test/keepAliveServer.test.js`: Database concurrency and HTTP health server.

