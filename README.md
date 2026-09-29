# Falak Agent Reward Bot v1.6.5

Native Telegram reward/referral bot with PostgreSQL and an advanced admin console.

UI direction:
- Premium compact Telegram-style hierarchy inspired by the supplied visual reference.
- Welcome poster + concise welcome message.
- Required and optional public/private channels.
- Admin-controlled channel buttons per row: 1, 2, or 3.
- Private channel Chat ID validation and Telegram access test.
- Referral deep links with automatic `/start ref_<telegram_id>` capture.
- Automatic home screen after successful membership verification (configurable).
- Wallet, tasks, gift codes, withdrawals, leaderboard, support.
- New-user notification to ADMIN_CHAT_ID.
- Railway webhook deployment.

Important:
- Telegram bots cannot load arbitrary custom font files into Telegram chat bubbles. This project uses Telegram HTML formatting and restrained Unicode typography for headings.
- For membership checks, add the bot as an administrator in channels that require verification.

Run:
npm install
npm start


### v1.6 UI architecture
- Permanent main navigation uses Telegram Reply Keyboard.
- Channel join/verification uses Inline Keyboard only.
- `/start` no longer renders a duplicate inline main menu.
- Channel layout remains configurable at 1, 2, or 3 buttons per row.
