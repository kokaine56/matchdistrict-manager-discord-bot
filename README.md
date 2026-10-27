# MatchDistrict Manager Discord Bot

Standalone Discord Bot for the MatchDistrict gaming community.
- Sends personalized welcome direct messages (DMs) to every player joining the Discord server.
- Supports **prefix commands** with default prefix `.`:
  - `.ping` — Check bot response time & WebSocket latency.
  - `.help` — Display list of available commands and bot help.
  - `.website` — Display the official MatchDistrict platform URL.
- Supports equivalent slash commands: `/ping`, `/help`, `/website`.
- Built-in HTTP health check endpoint for zero-configuration deployment on hosting platforms like Render, Railway, Fly.io, or Docker.

---

## Discord Developer Portal Configuration

### 1. Create Application & Bot
1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select your application (or click **New Application**).
3. Navigate to the **Bot** tab on the left sidebar.
4. Click **Reset Token** and copy your bot token securely (keep it confidential!).

### 2. Enable Privileged Gateway Intents (CRITICAL)
On the **Bot** tab, scroll down to the **Privileged Gateway Intents** section:
1. Toggle **ON** the switch for **SERVER MEMBERS INTENT** (allows sending welcome DMs to new members).
2. Toggle **ON** the switch for **MESSAGE CONTENT INTENT** (allows bot to read and respond to `.` prefix commands like `.ping`, `.help`, `.website`).
3. Click **Save Changes** at the bottom of the page.

### 3. Generate Invite Link
1. Go to **OAuth2** -> **OAuth2 URL Generator**.
2. Under **Scopes**, select:
   - `bot`
   - `applications.commands` (for slash commands)
3. Under **Bot Permissions**, select:
   - `Send Messages`
   - `Read Message History`
4. Copy the generated URL at the bottom and open it in a browser to invite the bot to your server.

---

## Local Development

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Set DISCORD_BOT_TOKEN in .env

# Run locally
npm start

# Or with auto-reload:
npm run dev
```

---

## Docker Deployment

### Build & Run Locally
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

---

## Deploying on Render

This repository is ready for direct deployment on Render:

1. Push this repository to GitHub (`matchdistrict-manager-discord-bot`).
2. Go to your [Render Dashboard](https://dashboard.render.com).
3. Click **New +** -> **Background Worker** (or **Web Service**).
4. Connect this GitHub repository.
5. Configuration:
   - **Environment**: `Docker`
   - **Dockerfile Path**: `Dockerfile`
   - **Plan**: `Free`
6. Add Environment Variable:
   - Key: `DISCORD_BOT_TOKEN`
   - Value: `your_bot_token`
7. Click **Create Service**.
