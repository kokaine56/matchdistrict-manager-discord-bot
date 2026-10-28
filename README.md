# MatchDistrict Manager Discord Bot

Standalone Discord Bot for the MatchDistrict gaming community.
- **Server Setup (`.setup`)**: Automatically provisions and configures 4 private management channels (`#bot-preview`, `#dm-log`, `#msg-log`, `#ban-unban-log`) with strict permission boundaries.
- **Welcome Direct Messages (`.dm welcome on / off`)**: Configurable, per-guild welcome direct messages with platform onboarding details and delivery outcome tracking.
- **Moderation Suite (`.ban`, `.clear`)**: Role-hierarchy-aware member banning with audit trail, and safe bulk message cleanup (1-100 messages) with 14-day Discord filter.
- **Audit & Activity Logging**:
  - `#dm-log`: Welcome DM delivery status, timestamps, account age, failure reasons (e.g. DMs disabled / blocked).
  - `#msg-log`: Regular member messages, edits, and deletions (excludes bots, administrators, and audit channels). Redacts tokens and secrets.
  - `#ban-unban-log`: Real-time member bans and unbans initiated via bot commands or Discord's native moderation interface, featuring audit log moderator resolution and duplicate prevention.
- **Built-in HTTP Health Check**: Zero-configuration endpoint for container hosting platforms like Render, Railway, Fly.io, or Docker.

---

## Command Reference (Prefix: `.`)

| Command | Permission | Description |
| :--- | :--- | :--- |
| `.setup` | Administrator / Manage Server | Creates or configures `#bot-preview`, `#dm-log`, `#msg-log`, `#ban-unban-log` idempotently. |
| `.dm welcome on` | Administrator / Manage Server | Enables welcome DMs for new members joining the server. |
| `.dm welcome off` | Administrator / Manage Server | Disables welcome DMs for new members. |
| `.ban @user [reason]` | Ban Members / Administrator | Bans a user by mention or ID with role-hierarchy checks and logs to `#ban-unban-log`. |
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
   - `Manage Channels` (for `.setup` to create and configure private channels)
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

1. **`#bot-preview`**:
   - Private management and status channel visible to administrators.
   - Displays real-time server configuration, welcome DM status, and full command guide.
2. **`#dm-log`**:
   - Records welcome DM delivery attempts (success / failure reasons such as closed privacy DMs).
3. **`#msg-log`**:
   - Records messages sent by regular members, message edits (before/after), and message deletions.
   - Automatically excludes bots, administrators, and messages within audit channels.
   - Automatically redacts bot tokens, API keys, and sensitive secrets.
4. **`#ban-unban-log`**:
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
