# MatchDistrict Manager Discord Bot

Standalone Discord Bot for the MatchDistrict gaming community.
- **Server Setup (`.setup`)**: Automatically provisions private management and member log channels, plus a public locked live member-count voice channel.
- **Member Count (`.member count <text>`)**: Sets the per-server member-count channel prefix, such as `Our Community: 37`.
- **Welcome Direct Messages (`.dm welcome on / off`)**: Configurable, per-guild welcome direct messages with platform onboarding details and delivery outcome tracking.
- **Moderation Suite (`.ban`, `.mute`, `.unmute`, `.clear`)**: Member bans, minute-based timeouts, timeout removal, and safe bulk message cleanup.
- **Audit & Activity Logging**:
  - `#bot-log`: Management card and bot/audit notices.
  - `#member-log`: Member join and leave events, plus welcome DM outcomes.
  - `#dm-log`: Welcome DM delivery status and failure reasons.
  - `#msg-log`: Regular member messages, edits, and deletions (excludes bots, administrators, and audit channels). Redacts tokens and secrets.
  - `#ban-unban-log`: Real-time member bans and unbans initiated via bot commands or Discord's native moderation interface, featuring audit log moderator resolution and duplicate prevention.
- **Built-in HTTP Health Check**: Zero-configuration endpoint for container hosting platforms like Render, Railway, Fly.io, or Docker.

---

## Command Reference (Prefix: `.`)

| Command | Permission | Description |
| :--- | :--- | :--- |
| `.setup` | Administrator / Manage Server | Creates or configures the management/member log channels and locked member-count voice channel idempotently. |
| `.member count <text>` | Administrator / Manage Server | Sets the member-count channel prefix without creating another channel. |
| `.setup remove` | Administrator / Manage Server | Initiates permanent deletion of bot management channels with a 30s confirmation prompt. |
| `.setup confirm` | Administrator / Manage Server | Explicitly confirms channel deletion initiated by `.setup remove`. |
| `.setup cancel` | Administrator / Manage Server | Aborts pending channel deletion request. |
| `.dm welcome on` | Administrator / Manage Server | Enables welcome DMs for new members joining the server. |
| `.dm welcome off` | Administrator / Manage Server | Disables welcome DMs for new members. |
| `.ban @user [reason]` | Ban Members / Administrator | Bans a user by mention or ID with role-hierarchy checks and logs to `#ban-unban-log`. |
| `.mute @user <minutes>` | Moderate Members / Administrator | Times out a user for the specified number of minutes. |
| `.unmute @user` | Moderate Members / Administrator | Removes a member timeout. |
| `.clear <1-100>` | Manage Messages / Administrator | Bulk-deletes messages (excluding private audit channels) respecting 14-day limits. |
| `.status` | Everyone | Displays server setup status, welcome DM toggle, and configured log channels. |
| `.ping` | Everyone | Measures bot roundtrip response time and WebSocket gateway latency. |
| `.help` | Everyone | Lists all available bot commands and usage guidelines. |
| `.website` | Everyone | Displays the official MatchDistrict platform URL and tournament features. |

---

## Discord Developer Portal Configuration

### 1. Create Application & Bot
1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select your application (or click **New Application**).
3. Navigate to the **Bot** tab on the left sidebar.
4. Click **Reset Token** and copy your bot token securely (keep it confidential!).

### 2. Enable Privileged Gateway Intents (CRITICAL)
On the **Bot** tab, scroll down to the **Privileged Gateway Intents** section:
1. Toggle **ON** **SERVER MEMBERS INTENT** (allows the bot to detect when new members join and dispatch welcome DMs).
2. Toggle **ON** **MESSAGE CONTENT INTENT** (allows the bot to parse `.` prefix commands and record message content in `#msg-log`).
3. Click **Save Changes** at the bottom of the page.

### 3. Generate Invite Link & Permissions
1. Go to **OAuth2** -> **OAuth2 URL Generator**.
2. Under **Scopes**, select:
   - `bot`
3. Under **Bot Permissions**, select:
   - `Manage Channels` (for `.setup` to create and configure channels)
   - `Moderate Members` (for `.mute` and `.unmute`)
   - `Ban Members` (for `.ban` command)
   - `Manage Messages` (for `.clear` command and command cleanup)
   - `View Audit Log` (to identify moderators and reasons for ban/unban events)
   - `Send Messages`
   - `Embed Links`
   - `Attach Files`
   - `Read Message History`
4. Copy the generated URL at the bottom and open it in a browser to invite the bot to your server.

---

## Management Channels Provisioned by `.setup`

1. **`#bot-log`**:
   - Private management and status channel visible to administrators.
   - Displays real-time server configuration, welcome DM status, and full command guide.
2. **`#dm-log`**:
   - Records welcome DM delivery attempts (success / failure reasons such as closed privacy DMs).
3. **`#member-log`**:
   - Records member joins and departures.
4. **`#msg-log`**:
   - Records messages sent by regular members, message edits (before/after), and message deletions.
   - Automatically excludes bots, administrators, and messages within audit channels.
   - Automatically redacts bot tokens, API keys, and sensitive secrets.
5. **`#ban-unban-log`**:
   - Records member bans and unbans from both bot commands (`.ban`) and native Discord moderation actions.
   - Captures target user, responsible moderator, reason, and timestamp with duplicate prevention.

---

## Local Development & Testing

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Set DISCORD_BOT_TOKEN in .env

# Run automated unit test suite (19 tests)
npm test

# Run locally
npm start

# Run with auto-reload
npm run dev
```

---

## Docker Deployment

### Build & Run
```bash
# Build Docker image
docker build -t matchdistrict-manager-discord-bot .

# Run container
docker run -d \
  --name matchdistrict-bot \
  -e DISCORD_BOT_TOKEN="your_token_here" \
  --restart unless-stopped \
  matchdistrict-manager-discord-bot
```
