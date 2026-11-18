# Country Elimination Game — YouTube Live starter

This package contains the updated game page and a small Node.js WebSocket backend.
The backend reads YouTube Live Chat using YouTube Data API v3. The API key is stored
in a server environment variable; it is not entered into or embedded in the browser page.

## Requirements
- Node.js 18 or newer
- A Google Cloud project with **YouTube Data API v3** enabled
- A YouTube Data API v3 API key
- A currently-live YouTube video with Live Chat enabled

## Run locally (computer)
1. Put `game1_youtube_ready.html`, `server.js`, and `package.json` in the same folder.
2. In that folder run: `npm install`
3. Set the API key as an environment variable (do not put it in the HTML):
   - macOS/Linux: `export YOUTUBE_API_KEY="YOUR_KEY"`
   - Windows PowerShell: `$env:YOUTUBE_API_KEY="YOUR_KEY"`
4. Run: `npm start`
5. On the computer open `http://localhost:8080`.
6. Open Settings → YouTube Live API v3. The backend URL should be `ws://localhost:8080/ws`.
7. Paste the live video ID or full YouTube URL, then click **Connect YouTube**.

## Use from a phone
`localhost` on a phone means the phone itself, not your computer. To use the computer
running the server, connect both devices to the same Wi-Fi and enter the computer's
LAN address, for example `ws://192.168.1.20:8080/ws` (replace with the computer's actual
LAN IP). Allow inbound port 8080 in the computer firewall if needed.

For public/remote use, deploy the Node server to a host with HTTPS and WebSocket support,
then use `wss://YOUR-DOMAIN/ws`. Do not use `ws://` from an HTTPS-hosted game page; browsers
block insecure mixed-content WebSockets.

## Game behavior
- Real YouTube chat is the only source of votes by default.
- The previous synthetic chat simulator is now opt-in for local demos only: append `?demo=1`
  to the game URL to enable it. Do not use demo mode during a real stream.
- A chat message containing a country name or 2-letter country code is counted by the
  game's existing `processChatVote` logic. Existing thresholds remain: 20 chat votes
  trigger a shield; 40 votes revive an eliminated country. Super Chats and new sponsor
  events are mapped to the game's existing `superchat` / `sub` event handling.
- The existing optional external WebSocket bridge remains separate.

## Troubleshooting
- **No active live chat found**: the video must be live now and Live Chat must be enabled.
- **403 / quotaExceeded**: check API enablement, key restrictions, and Google Cloud quota.
- **API key invalid**: verify `YOUTUBE_API_KEY` on the server; never paste it into the public HTML.
- **Phone cannot connect**: use the computer's LAN IP, not `localhost`; check Wi-Fi and firewall.
- **HTTPS page cannot connect**: use a secure `wss://` backend URL.

This is a starter implementation, not a guarantee of production hosting or YouTube approval.
You must deploy and configure the backend yourself. Keep the API key private and restrict it
in Google Cloud to the YouTube Data API v3 where possible.
