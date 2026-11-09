# MatchDistrict Discord Bot Agent Instructions

These instructions govern all AI agent tasks within `matchdistrict-manager-discord-bot/`.

## 1. Project Scope & Isolation
- Work strictly inside `matchdistrict-manager-discord-bot/`.
- Do not inspect or modify `matchdistrict-website/`, `matchdistrict-whatsapp-dm/`, or root utility directories.
- Before reading code or implementing changes, consult [`PROJECT_CONTEXT.md`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/PROJECT_CONTEXT.md) to understand existing bot commands, services, and event pipelines.

## 2. File Exploration & Inspection Rules
- Do NOT read the entire 3,600+ lines of `index.js` or 500+ KB of `tournamentService.js` all at once.
- Locate the relevant service module (e.g., `ticketService.js`, `moderationService.js`, `configurableTournamentService.js`, `auditLogger.js`, `mongoService.js`, `inviteCampaign/`) and read only the target function/event handler using bounded ranges (`StartLine`/`EndLine`).
- Never perform unbounded searches or scans in `node_modules/` or `.git/`.

## 3. Discord.js v14 Architecture Conventions
- **ES Modules**: Use standard ES module `import`/`export` syntax.
- **Interaction Replies**: Always reply or defer interactions within 3 seconds (`interaction.deferReply()` or `interaction.reply({ ephemeral: true })`) to avoid Discord webhook timeouts.
- **Permission Checking**: Before performing channel creation, role creation, kicks, timeouts, or bans, verify the bot's own guild permissions and role hierarchy.
- **Audit Logging**: Use `auditLogger.js` for guild events. Never log raw bot tokens, API keys, or member credentials into log channels or console.
- **Database Operations**: Use `mongoService.js` for MongoDB queries and maintain cache coherence with `guildSettings.json` when applicable.

## 4. Testing & Verification
- Run tests using Node.js built-in test runner:
  ```powershell
  # Run all bot tests
  node --test
  # Run a specific test suite
  node --test test/configurableTournament.test.js
  node --test test/tournament.test.js
  ```
- Always verify changes with the corresponding test suite before concluding a task.

## 5. Context Maintenance
- If a new command, event handler, or database collection is introduced or modified, update the relevant section of [`PROJECT_CONTEXT.md`](file:///E:/Projects/Project-MatchDistrict/matchdistrict-manager-discord-bot/PROJECT_CONTEXT.md).

