# LiveNote Secure Beta

Mobile-first ephemeral realtime chat with temporary text and image messages.

## Added hardening
- Helmet security headers with CSP
- Express rate limiting on room creation and image uploads
- Socket-level throttling for join, message, typing, and kill events
- Per-IP socket cap
- Per-IP joined-room cap
- Stronger room URLs like `/green-apple-a3f2`
- Auto-delete unused rooms after 60 seconds
- No persistent database
- Temporary in-memory images only
- Message text is escaped on the client
- `X-Content-Type-Options: nosniff` on image responses

## Still not included
- End-to-end encryption
- Account system
- CAPTCHA / bot challenge
- Durable abuse dashboards

## Run
```bash
npm install
npm start
```

Open:
```bash
http://localhost:3000
```
