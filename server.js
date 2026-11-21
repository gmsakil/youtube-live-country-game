// Flags War Arena — YouTube Live Chat streaming bridge
// Uses Google's official liveChatMessages.streamList gRPC method.
// API key stays on the server. No Gemini API is used.
// Node.js 18+
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PORT = Number(process.env.PORT || 8080);
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const GAME_FILE = path.join(__dirname, 'game1_youtube_ready.html');
const PROTO_FILE = path.join(__dirname, 'stream_list.proto');

const packageDefinition = protoLoader.loadSync(PROTO_FILE, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true
});
const youtubeProto = grpc.loadPackageDefinition(packageDefinition);
const LiveChatService = youtubeProto.youtube.api.v3.V3DataLiveChatMessageService;

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname === '/' || pathname === '/game1_youtube_ready.html') {
    fs.createReadStream(GAME_FILE).on('error', () => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Game HTML file missing.');
    }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Flags War Arena streaming bridge is running.');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
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

async function getLiveChatId(videoId) {
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'liveStreamingDetails');
  url.searchParams.set('id', videoId);
  url.searchParams.set('key', YOUTUBE_API_KEY);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    const message = data?.error?.message || `YouTube API HTTP ${response.status}`;
    throw new Error(reason ? `${reason}: ${message}` : message);
  }
  const chatId = data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) {
    throw new Error('No active live chat found. The video must be live and Live Chat must be enabled.');
  }
  return chatId;
}

function getMessage(item) {
  const snippet = item.snippet || {};
  const author = item.author_details?.display_name || '';
  const type = snippet.type;
  let message = '';
  let eventType = 'chat';

  if (type === 'TEXT_MESSAGE_EVENT') {
    message = snippet.text_message_details?.message_text || '';
  } else if (type === 'SUPER_CHAT_EVENT') {
    message = snippet.super_chat_details?.user_comment || '';
    eventType = 'superchat';
  } else if (type === 'NEW_SPONSOR_EVENT') {
    message = author;
    eventType = 'sub';
  }

  return message ? {
    type: 'chat',
    message,
    eventType,
    messageId: item.id || '',
    author
  } : null;
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const videoId = getVideoId(url.searchParams.get('videoId'));
  let stopped = false;
  let activeCall = null;
  let reconnectTimer = null;
  let reconnectDelay = 3000;
  let pageToken = '';
  const seen = new Set();
  const seenOrder = [];

  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (activeCall) {
      try { activeCall.cancel(); } catch (_) {}
      activeCall = null;
    }
  };
  ws.on('close', stop);
  ws.on('error', stop);

  // Keep Render/browser WebSocket alive. This does not call YouTube API.
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'heartbeat') {
        send(ws, { type: 'heartbeat_ack', timestamp: Date.now() });
      }
    } catch (_) {}
  });

  if (!YOUTUBE_API_KEY) {
    send(ws, { type: 'error', message: 'Server is missing YOUTUBE_API_KEY environment variable.' });
    ws.close(1011, 'Server not configured');
    return;
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    send(ws, { type: 'error', message: 'Invalid YouTube video ID.' });
    ws.close(1008, 'Invalid video ID');
    return;
  }

  try {
    const chatId = await getLiveChatId(videoId);
    if (stopped) return;

    send(ws, {
      type: 'status',
      state: 'LIVE',
      message: 'Connected to YouTube Live Chat using official streaming mode.'
    });

    const client = new LiveChatService(
      'youtube.googleapis.com:443',
      grpc.credentials.createSsl()
    );
    const metadata = new grpc.Metadata();
    metadata.add('x-goog-api-key', YOUTUBE_API_KEY);

    const scheduleReconnect = (message) => {
      if (stopped || ws.readyState !== WebSocket.OPEN || reconnectTimer) return;
      if (message) send(ws, { type: 'status', state: 'RECONNECTING', message });
      const wait = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 900000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openStream();
      }, wait);
    };

    const openStream = () => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;

      const request = {
        live_chat_id: chatId,
        part: ['snippet', 'authorDetails']
      };
      if (pageToken) request.page_token = pageToken;

      activeCall = client.streamList(request, metadata);
      let gotData = false;

      activeCall.on('data', response => {
        gotData = true;
        reconnectDelay = 3000;

        if (response.next_page_token) pageToken = response.next_page_token;

        for (const item of (response.items || [])) {
          if (item.id && seen.has(item.id)) continue;
          if (item.id) {
            seen.add(item.id);
            seenOrder.push(item.id);
            if (seenOrder.length > 5000) seen.delete(seenOrder.shift());
          }
          const event = getMessage(item);
          if (event) send(ws, event);
        }
      });

      activeCall.on('error', err => {
        activeCall = null;
        if (stopped || ws.readyState !== WebSocket.OPEN) return;

        const details = err.details || err.message || 'Live chat stream disconnected.';
        // Back off on failures; never hammer the API during quota or network errors.
        scheduleReconnect(details);
      });

      activeCall.on('end', () => {
        activeCall = null;
        if (stopped || ws.readyState !== WebSocket.OPEN) return;
        scheduleReconnect(gotData
          ? 'YouTube stream ended. Reconnecting...'
          : 'Waiting to reconnect to YouTube Live Chat...');
      });
    };

    openStream();
  } catch (err) {
    send(ws, { type: 'error', message: err.message || 'Could not connect to YouTube Live.' });
    ws.close(1011, 'YouTube connection failed');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Flags War Arena bridge listening on port ${PORT}`);
  if (!YOUTUBE_API_KEY) console.warn('Set YOUTUBE_API_KEY in the server environment.');
});
