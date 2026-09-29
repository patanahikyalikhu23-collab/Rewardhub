# Falak Agent Reward Bot

Production-oriented Telegram reward/referral bot foundation.

## Channel setup
- Public channel: use `@channelusername` as Chat ID and/or username, plus a public `https://t.me/channel` URL.
- Private channel: use the numeric Chat ID (usually `-100...`) and a private invite URL such as `https://t.me/+...`.
- Add the bot as an administrator to channels where membership verification is required.
- Choose `Required` to gate access or `Optional` to display a channel without blocking/verification.

## Referral
Referral links use Telegram deep links such as `https://t.me/YourBot?start=ref_123456789`.

## Important
Telegram bots cannot start a private chat with a user who has never started the bot. `/start` or a Telegram deep link is required to open the conversation.
