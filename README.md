# Falak Agent Reward Bot

Production-oriented Telegram reward/referral bot starter for Railway.

## Included in v1
- Native Telegram reply-keyboard main menu
- Welcome/start image + configurable welcome text
- Required and optional public/private channels
- Membership verification
- Referral links and qualified referral rewards
- Task/reward engine
- Wallet + transaction ledger
- Gift codes
- Withdrawal requests + admin pay/reject/refund
- Text/photo/video broadcasts
- Admin dashboard with channel/task/gift/broadcast/withdrawal management
- JWT-protected admin panel
- PostgreSQL
- Telegram webhook

## Railway
1. Create PostgreSQL in the same Railway project.
2. Deploy this repository/service.
3. Set BOT_TOKEN, DATABASE_URL, JWT_SECRET, WEBHOOK_SECRET, BASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD.
4. Generate a public domain and put it in BASE_URL.
5. Redeploy.

The application creates/updates its required tables on startup.

### New-user admin notifications
Set `ADMIN_CHAT_ID` to the Telegram numeric ID of the admin account. When a brand-new user starts the bot, the admin receives a notification containing the user name, username, Telegram ID, and referral information. The admin must have opened/started the bot at least once so the bot can message that account.
