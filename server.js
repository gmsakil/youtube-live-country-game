// Minimal YouTube Live Chat bridge. API key stays on this server, never in the browser.
// Node.js 18+; install dependencies with: npm install
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GAME_FILE = path.join(__dirname, 'game1_youtube_ready.html');

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/' || pathname === '/game1_youtube_ready.html') {
    fs.createReadStream(GAME_FILE).on('error', () => {
      res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Game HTML file missing.');
    }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('YouTube Live bridge is running. Open / to load the game.');
});
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function getVideoId(raw) {
  const value = (raw || '').trim();
  const match = value.match(/(?:v=|\/live\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : value;
}
async function ytGet(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: YOUTUBE_API_KEY })) url.searchParams.set(k, String(v));
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    const message = data?.error?.message || `YouTube API HTTP ${response.status}`;
    const err = new Error(reason ? `${reason}: ${message}` : message);
    err.status = response.status; throw err;
  }
  return data;
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const videoId = getVideoId(url.searchParams.get('videoId'));
  let stopped = false;
  let timer = null;
  let pageToken = '';
  const seen = new Set();
  const seenOrder = [];
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
  ws.on('close', stop); ws.on('error', stop);

  // Application-level heartbeat: browser clients send this every 30 seconds.
  // Render Free services count incoming WebSocket messages as inbound traffic.
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message && message.type === 'heartbeat') {
        send(ws, { type: 'heartbeat_ack', timestamp: Date.now() });
      }
    } catch (_) {
      // Ignore non-JSON or unrelated client messages.
    }
  });

  if (!YOUTUBE_API_KEY) {
    send(ws, { type: 'error', message: 'Server is missing YOUTUBE_API_KEY environment variable.' });
    ws.close(1011, 'Server not configured'); return;
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    send(ws, { type: 'error', message: 'Invalid YouTube video ID.' });
    ws.close(1008, 'Invalid video ID'); return;
  }

  try {
    const videos = await ytGet('videos', { part: 'liveStreamingDetails', id: videoId });
    const chatId = videos.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chatId) throw new Error('No active live chat found. Check that the video is currently live and Live Chat is enabled.');
    send(ws, { type: 'status', state: 'LIVE', message: 'Connected to YouTube Live Chat.' });

    const poll = async () => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      try {
        const params = { liveChatId: chatId, part: 'snippet,authorDetails', maxResults: 200 };
        if (pageToken) params.pageToken = pageToken;
        const data = await ytGet('liveChat/messages', params);
        for (const item of (data.items || [])) {
          const id = item.id;
          if (!id || seen.has(id)) continue;
          seen.add(id); seenOrder.push(id);
          if (seenOrder.length > 5000) seen.delete(seenOrder.shift());
          const snippet = item.snippet || {};
          let message = '';
          let eventType = 'chat';
          if (snippet.type === 'textMessageEvent') message = snippet.textMessageDetails?.messageText || '';
          else if (snippet.type === 'superChatEvent') {
            message = snippet.superChatDetails?.userComment || '';
            eventType = 'superchat';
          } else if (snippet.type === 'newSponsorEvent') {
            message = item.authorDetails?.displayName || '';
            eventType = 'sub';
          }
          if (message) send(ws, { type: 'chat', message, eventType, messageId: id, author: item.authorDetails?.displayName || '' });
        }
        pageToken = data.nextPageToken || pageToken;
        timer = setTimeout(poll, Math.max(1000, Number(data.pollingIntervalMillis || 5000)));
      } catch (err) {
        send(ws, { type: 'error', message: err.message || 'YouTube polling failed.' });
        // Quota/auth errors are not fixed by rapid retries.
        const delay = err.status === 403 ? 15000 : 7000;
        timer = setTimeout(poll, delay);
      }
    };
    poll();
  } catch (err) {
    send(ws, { type: 'error', message: err.message || 'Could not connect to YouTube Live.' });
    ws.close(1011, 'YouTube connection failed');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Game + YouTube bridge listening on http://localhost:${PORT}`);
  if (!YOUTUBE_API_KEY) console.warn('Set YOUTUBE_API_KEY before connecting YouTube Live.');
});
