const path = require('path');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const { Server } = require('socket.io');
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

const app = express();
app.set('trust proxy', 1);

Sentry.init({
  dsn: process.env.SENTRY_DSN_SERVER,
  environment: process.env.NODE_ENV || 'development',
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 0.2,
  profilesSampleRate: 0.2,
  sendDefaultPii: false,
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
});

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const UNUSED_ROOM_TTL_MS = 60 * 1000;
const MAX_ROOMS = 5000;
const MAX_MESSAGES = 250;
const MAX_MESSAGE_LENGTH = 1500;
const MAX_SOCKETS_PER_IP = 12;
const MAX_JOINED_ROOMS_PER_IP = 20;
const MAX_UPLOAD_SIZE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES_PER_ROOM = 12 * 1024 * 1024;
const MAX_IMAGES_PER_ROOM = 40;
const MAX_IMAGE_WIDTH = 1280;
const MAX_IMAGE_HEIGHT = 1280;
const IMAGE_QUALITY = 72;

const USER_COLORS = [
  '#7c9cff', '#59d9b7', '#ff9f6e', '#f779c1', '#ffd166',
  '#c792ea', '#6ee7ff', '#a3e635', '#fb7185', '#22d3ee'
];

const ROOM_ADJECTIVES = [
  'amber','arctic','atomic','azure','blazing','blooming','breezy','bronze','bubbly','calm',
  'chilly','chill','crimson','daring','dusty','echoing','ember','fancy','feisty','fluffy',
  'frosty','gentle','glossy','gritty','hollow','icy','jaded','jumpy','kind','lunar',
  'mellow','misty','moody','murky','noble','oceanic','opal','peppy','plush','primal',
  'quiet','radiant','rusty','shady','shiny','smoky','smooth','stormy','tender','vivid'
];

const ROOM_NOUNS = [
  'anchor','avalanche','beacon','blossom','canyon','castle','cavern','cherry','citadel','coral',
  'crystal','desert','ember','feather','fjord','flame','glacier','grove','harbor','island',
  'jungle','lagoon','lantern','lighthouse','meteor','mirage','nebula','oasis','orchard','palace',
  'pebble','reef','ridge','safari','sandstorm','shadow','shrine','skylight','snowfall','spark',
  'summit','temple','tornado','valley','volcano','waterfall','whirlpool','willow','zenith','zeppelin'
];

const NAME_ADJECTIVES = [
  'Blazing','Chill','Daring','Epic','Fierce','Flashy','Glitchy','Groovy','Hyper','Icy',
  'Jazzy','Kooky','Legendary','Loud','Moody','Nimble','Oddball','Peppy','Quirky','Rad',
  'Rogue','Savage','Shiny','Snappy','Speedy','Spooky','Stealthy','Stormy','Swaggy','Tasty',
  'Trippy','Viral','Witty','Zany','Electric','Frosty','Golden','Hollow','Jumpy','Lucky',
  'Mystic','Nocturnal','Plucky','Rowdy','Slick','Sneaky','Spark','Turbocharged','Wild','Zesty'
];

const NAME_NOUNS = [
  'Alien','Avocado','Badger','Biscuit','Blob','Buffalo','Chimera','Cobra','Crab','Dinosaur',
  'Donut','Eagle','Falcon','Ferret','Flamingo','Frog','Giraffe','Golem','Goose','Hawk',
  'Hedgehog','Hippo','Jaguar','Jelly','Kitten','Kraken','Lobster','Mantis','Meerkat','Moose',
  'Narwhal','Octopus','Owl','Panther','Parrot','Penguin','Piranha','Puffin','Rhino','Shark',
  'Sloth','Snail','Spider','Squirrel','Stallion','Toad','Turtle','Viper','Wolf','Yak'
];

const rooms = new Map();
const ipConnectionCounts = new Map();
const ipActiveRooms = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed.'));
    }
    cb(null, true);
  },
});

function getClientIp(reqOrSocket) {
  const raw =
    reqOrSocket?.headers?.['x-forwarded-for'] ||
    reqOrSocket?.handshake?.headers?.['x-forwarded-for'] ||
    reqOrSocket?.socket?.remoteAddress ||
    reqOrSocket?.conn?.remoteAddress ||
    reqOrSocket?.request?.socket?.remoteAddress ||
    reqOrSocket?.handshake?.address ||
    'unknown';

  return String(raw).split(',')[0].trim();
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function createRoomId() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = `${randomFrom(ROOM_ADJECTIVES)}-${randomFrom(ROOM_NOUNS)}-${crypto.randomBytes(2).toString('hex')}`;
    if (!rooms.has(id)) return id;
  }
  return crypto.randomUUID();
}

function createFunnyName(existingNames = new Set()) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = `${randomFrom(NAME_ADJECTIVES)}${randomFrom(NAME_NOUNS)}`;
    if (!existingNames.has(name)) return name;
  }
  return `Mystery${crypto.randomBytes(2).toString('hex')}`;
}

function getRoomImageUsageBytes(room) {
  let total = 0;
  for (const asset of room.assets.values()) total += asset.buffer.length;
  return total;
}

function createRoom(roomId, roomType = 'private') {
  if (rooms.size >= MAX_ROOMS) {
    throw new Error('Server is at room capacity. Please try again later.');
  }

  const now = Date.now();
  const room = {
    id: roomId,
    type: roomType === 'admin' ? 'admin' : 'private',
    adminSocketId: null,
    messages: [],
    users: new Map(),
    typing: new Map(),
    assets: new Map(),
    createdAt: now,
    expiresAt: now + ROOM_TTL_MS,
    expiryTimer: null,
    unusedTimer: null,
  };

  rooms.set(roomId, room);
  scheduleRoomExpiry(roomId);
  scheduleUnusedRoomExpiry(roomId);
  return room;
}

function extendRoomExpiry(room) {
  room.expiresAt = Date.now() + ROOM_TTL_MS;
  scheduleRoomExpiry(room.id);
}

function scheduleRoomExpiry(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.expiryTimer) clearTimeout(room.expiryTimer);

  const delay = Math.max(1000, room.expiresAt - Date.now());
  room.expiryTimer = setTimeout(() => destroyRoom(roomId, 'expired'), delay);
}

function scheduleUnusedRoomExpiry(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.unusedTimer) clearTimeout(room.unusedTimer);

  room.unusedTimer = setTimeout(() => {
    const active = rooms.get(roomId);
    if (active && active.users.size === 0) destroyRoom(roomId, 'unused');
  }, UNUSED_ROOM_TTL_MS);
}

function clearUnusedRoomExpiry(room) {
  if (room.unusedTimer) {
    clearTimeout(room.unusedTimer);
    room.unusedTimer = null;
  }
}

function updateIpRoomCount(ip, delta) {
  const current = ipActiveRooms.get(ip) || 0;
  const next = current + delta;
  if (next <= 0) ipActiveRooms.delete(ip);
  else ipActiveRooms.set(ip, next);
}

function destroyRoom(roomId, reason = 'deleted') {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.expiryTimer) clearTimeout(room.expiryTimer);
  if (room.unusedTimer) clearTimeout(room.unusedTimer);

  io.to(roomId).emit('room:killed', { reason });

  for (const [socketId, user] of room.users.entries()) {
    updateIpRoomCount(user.ip, -1);
    const clientSocket = io.sockets.sockets.get(socketId);
    if (clientSocket) {
      clientSocket.leave(roomId);
      clientSocket.data.roomId = null;
      clientSocket.data.userId = null;
    }
  }

  room.assets.clear();
  rooms.delete(roomId);
}

function sanitizeMessage(value) {
  return String(value || '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

function buildAssetUrl(roomId, assetId) {
  return `/room-assets/${roomId}/${assetId}`;
}

function serializeMessage(roomId, message) {
  return {
    id: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    senderColor: message.senderColor,
    text: message.text,
    createdAt: message.createdAt,
    kind: message.kind || 'text',
    image: message.imageAssetId
      ? {
          assetId: message.imageAssetId,
          url: buildAssetUrl(roomId, message.imageAssetId),
          width: message.imageWidth,
          height: message.imageHeight,
          sizeBytes: message.imageBytes,
        }
      : null,
  };
}

function roomPayload(room) {
  return {
    roomId: room.id,
    roomType: room.type,
    participants: room.users.size,
    messages: room.messages.map((message) => serializeMessage(room.id, message)),
    users: Array.from(room.users.values()).map((user) => ({
      id: user.id,
      name: user.name,
      color: user.color,
      isAdmin: user.id === room.adminSocketId,
    })),
    typing: Array.from(room.typing.values()),
    expiresAt: room.expiresAt,
  };
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room:state', roomPayload(room));
}

function removeTyping(room, socketId) {
  room.typing.delete(socketId);
}

function trimMessages(room) {
  if (room.messages.length <= MAX_MESSAGES) return;
  const removed = room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  const removedAssetIds = new Set(removed.map((m) => m.imageAssetId).filter(Boolean));

  for (const assetId of removedAssetIds) {
    const stillReferenced = room.messages.some((m) => m.imageAssetId === assetId);
    if (!stillReferenced) room.assets.delete(assetId);
  }
}

function deleteMessageById(room, messageId, requesterId) {
  const index = room.messages.findIndex(
    (message) => message.id === messageId && message.senderId === requesterId
  );
  if (index === -1) return false;

  const [removed] = room.messages.splice(index, 1);
  if (removed?.imageAssetId) {
    const stillReferenced = room.messages.some((m) => m.imageAssetId === removed.imageAssetId);
    if (!stillReferenced) room.assets.delete(removed.imageAssetId);
  }

  return true;
}

function logSecurity(event, meta = {}) {
  console.warn(`[security] ${event}`, meta);
}

function createSocketLimiter({ limit, windowMs, keyFn }) {
  const buckets = new Map();

  return function check(socket) {
    const now = Date.now();
    const key = `${keyFn(socket)}:${windowMs}:${limit}`;
    const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    return bucket.count <= limit;
  };
}

async function sendPlausibleEvent(req, name, props = {}) {
  try {
    const domain = process.env.PLAUSIBLE_DOMAIN;
    if (!domain) return;

    await fetch('https://plausible.io/api/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'HushrChat Server Analytics',
      },
      body: JSON.stringify({
        name,
        url: `${req.protocol}://${req.get('host')}${req.originalUrl || '/'}`,
        domain,
        props,
      }),
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: 'analytics', provider: 'plausible', side: 'server' },
      extra: { eventName: name, props },
    });
  }
}

const socketLimitByIp = (limit, windowMs) =>
  createSocketLimiter({
    limit,
    windowMs,
    keyFn: (socket) => getClientIp(socket),
  });

const joinLimiter = socketLimitByIp(20, 60_000);
const messageLimiter = socketLimitByIp(20, 10_000);
const typingLimiter = socketLimitByIp(16, 5_000);
const killLimiter = socketLimitByIp(5, 60_000);

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many room creations from this IP. Please wait a bit.' },
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many image uploads from this IP. Please wait a bit.' },
});

if (IS_PROD) {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && proto !== 'https') {
      return res.redirect(`https://${req.headers.host}${req.originalUrl}`);
    }
    next();
  });
}

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],

    scriptSrc: [
      "'self'",
      "https://plausible.io",
      "https://browser.sentry-cdn.com"
    ],

    styleSrc: ["'self'", "'unsafe-inline'"],

    imgSrc: ["'self'", "data:", "blob:"],

    connectSrc: [
      "'self'",
      "ws:",
      "wss:",
      "https://plausible.io",
      "https://*.ingest.sentry.io"
    ],

    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
  },
},
    referrerPolicy: { policy: 'no-referrer' },
  })
);

app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/env.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.__ENV__ = {
      SENTRY_DSN: "${process.env.SENTRY_DSN_BROWSER || ''}"
    };
  `);
});

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(
    `window.APP_CONFIG = ${JSON.stringify({
      sentryBrowserDsn: process.env.SENTRY_DSN_BROWSER || '',
      environment: NODE_ENV,
      plausibleDomain: process.env.PLAUSIBLE_DOMAIN || '',
    })};`
  );
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/rooms', createLimiter, async (req, res) => {
  try {
    const roomType = req.body?.roomType === 'admin' ? 'admin' : 'private';
    const roomId = createRoomId();
    createRoom(roomId, roomType);

    await sendPlausibleEvent(req, 'room_created', {
      room_type: roomType,
    });

    res.json({
      roomId,
      roomType,
      url: `/${roomId}`,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: 'room_create' },
    });
    res.status(503).json({ error: error.message || 'Could not create room.' });
  }
});

app.post('/api/rooms/:roomId/upload-image', uploadLimiter, upload.single('image'), async (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms.get(roomId);

  if (!room) {
    await sendPlausibleEvent(req, 'image_upload_failed', { reason: 'room_not_found' });
    return res.status(404).json({ error: 'Room not found.' });
  }

  if (!req.file) {
    await sendPlausibleEvent(req, 'image_upload_failed', { reason: 'no_file' });
    return res.status(400).json({ error: 'No image received.' });
  }

  if (room.assets.size >= MAX_IMAGES_PER_ROOM) {
    await sendPlausibleEvent(req, 'image_upload_failed', { reason: 'room_image_limit' });
    return res.status(400).json({ error: 'This room reached the image limit.' });
  }

  try {
    const transformed = sharp(req.file.buffer)
      .rotate()
      .resize({
        width: MAX_IMAGE_WIDTH,
        height: MAX_IMAGE_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY });

    const metadata = await transformed.metadata();
    const compressed = await transformed.toBuffer();

    if (getRoomImageUsageBytes(room) + compressed.length > MAX_IMAGE_BYTES_PER_ROOM) {
      await sendPlausibleEvent(req, 'image_upload_failed', { reason: 'room_temp_space_exceeded' });
      return res.status(400).json({ error: 'This room is out of temporary image space.' });
    }

    const assetId = crypto.randomUUID();
    room.assets.set(assetId, {
      id: assetId,
      buffer: compressed,
      mimeType: 'image/webp',
      createdAt: Date.now(),
      width: metadata.width || null,
      height: metadata.height || null,
    });

    extendRoomExpiry(room);

    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found.' });

    await sendPlausibleEvent(req, 'image_upload_success', {
      room_type: room.type,
    });

    return res.json({
      assetId,
      url: buildAssetUrl(roomId, assetId),
      mimeType: 'image/webp',
      width: metadata.width || null,
      height: metadata.height || null,
      sizeBytes: compressed.length,
    });
  } catch (error) {
    await sendPlausibleEvent(req, 'image_upload_failed', { reason: 'processing_error' });
    Sentry.captureException(error, {
      tags: { area: 'image_upload' },
      extra: { roomId },
    });
    logSecurity('image_processing_failed', { roomId, error: String(error) });
    return res.status(400).json({ error: 'Could not process that image.' });
  }
});

app.get('/room-assets/:roomId/:assetId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).send('Not found');

  const asset = room.assets.get(req.params.assetId);
  if (!asset) return res.status(404).send('Not found');

  extendRoomExpiry(room);
  res.setHeader('Content-Type', asset.mimeType);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline; filename="shared-image.webp"');
  res.send(asset.buffer);
});

app.get('/:roomId([a-z0-9-]+)', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

io.use((socket, next) => {
  const ip = getClientIp(socket);
  const current = ipConnectionCounts.get(ip) || 0;
  if (current >= MAX_SOCKETS_PER_IP) {
    Sentry.captureMessage('Socket connection limit reached', {
      level: 'warning',
      tags: { area: 'socket_connect_limit' },
      extra: { ip },
    });
    return next(new Error('Too many active connections from this IP.'));
  }
  socket.data.clientIp = ip;
  ipConnectionCounts.set(ip, current + 1);
  next();
});

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.userId = null;
  socket.data.typingTimeout = null;

  socket.on('room:join', ({ roomId }) => {
    if (!joinLimiter(socket)) {
      Sentry.captureMessage('Join rate limited', {
        level: 'warning',
        tags: { area: 'room_join_rate_limit' },
        extra: { roomId, ip: socket.data.clientIp },
      });
      socket.emit('room:error', { message: 'Too many join attempts. Please slow down.' });
      return;
    }

    if (!roomId || !/^[a-z0-9-]+$/.test(roomId)) {
      Sentry.captureMessage('Invalid room ID supplied', {
        level: 'warning',
        tags: { area: 'room_join_invalid_id' },
        extra: { roomId, ip: socket.data.clientIp },
      });
      socket.emit('room:error', { message: 'Invalid room ID.' });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('room:not-found');
      return;
    }

    const ip = socket.data.clientIp;
    if ((ipActiveRooms.get(ip) || 0) >= MAX_JOINED_ROOMS_PER_IP) {
      Sentry.captureMessage('Too many joined rooms from IP', {
        level: 'warning',
        tags: { area: 'room_join_ip_limit' },
        extra: { roomId, ip },
      });
      socket.emit('room:error', { message: 'Too many joined rooms from this IP.' });
      return;
    }

    extendRoomExpiry(room);
    clearUnusedRoomExpiry(room);

    const existingNames = new Set(Array.from(room.users.values()).map((user) => user.name));
    const profile = {
      id: socket.id,
      name: createFunnyName(existingNames),
      color: USER_COLORS[room.users.size % USER_COLORS.length],
      ip,
    };

    if (room.type === 'admin' && !room.adminSocketId) room.adminSocketId = socket.id;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = socket.id;
    room.users.set(socket.id, profile);
    updateIpRoomCount(ip, 1);

    socket.emit('room:joined', {
      self: {
        id: profile.id,
        name: profile.name,
        color: profile.color,
        isAdmin: socket.id === room.adminSocketId,
      },
      roomType: room.type,
      expiresAt: room.expiresAt,
    });

    broadcastRoomState(roomId);
  });

  socket.on('room:send-message', ({ roomId, text }) => {
    if (!messageLimiter(socket)) return;
    const room = rooms.get(roomId);

    if (!room || socket.data.roomId !== roomId) {
      socket.emit('room:error', { message: 'Room no longer exists.' });
      return;
    }

    const user = room.users.get(socket.id);
    const cleanText = sanitizeMessage(text);
    if (!user || !cleanText) return;

    extendRoomExpiry(room);
    removeTyping(room, socket.id);

    if (socket.data.typingTimeout) {
      clearTimeout(socket.data.typingTimeout);
      socket.data.typingTimeout = null;
    }

    room.messages.push({
      id: crypto.randomUUID(),
      senderId: user.id,
      senderName: user.name,
      senderColor: user.color,
      text: cleanText,
      createdAt: Date.now(),
      kind: 'text',
    });

    trimMessages(room);
    broadcastRoomState(roomId);
  });

  socket.on('room:send-image', ({ roomId, assetId, text = '' }) => {
    if (!messageLimiter(socket)) return;
    const room = rooms.get(roomId);

    if (!room || socket.data.roomId !== roomId) {
      socket.emit('room:error', { message: 'Room no longer exists.' });
      return;
    }

    const user = room.users.get(socket.id);
    const asset = room.assets.get(assetId);
    const cleanText = sanitizeMessage(text);
    if (!user || !asset) return;

    extendRoomExpiry(room);
    removeTyping(room, socket.id);

    if (socket.data.typingTimeout) {
      clearTimeout(socket.data.typingTimeout);
      socket.data.typingTimeout = null;
    }

    room.messages.push({
      id: crypto.randomUUID(),
      senderId: user.id,
      senderName: user.name,
      senderColor: user.color,
      text: cleanText,
      createdAt: Date.now(),
      kind: 'image',
      imageAssetId: assetId,
      imageWidth: asset.width,
      imageHeight: asset.height,
      imageBytes: asset.buffer.length,
    });

    trimMessages(room);
    broadcastRoomState(roomId);
  });

  socket.on('room:typing', ({ roomId, isTyping }) => {
    if (!typingLimiter(socket)) return;
    const room = rooms.get(roomId);
    if (!room || socket.data.roomId !== roomId) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    if (isTyping) {
      room.typing.set(socket.id, { id: user.id, name: user.name, color: user.color });
      if (socket.data.typingTimeout) clearTimeout(socket.data.typingTimeout);

      socket.data.typingTimeout = setTimeout(() => {
        const activeRoom = rooms.get(roomId);
        if (!activeRoom) return;
        removeTyping(activeRoom, socket.id);
        broadcastRoomState(roomId);
      }, 1400);
    } else {
      removeTyping(room, socket.id);
      if (socket.data.typingTimeout) {
        clearTimeout(socket.data.typingTimeout);
        socket.data.typingTimeout = null;
      }
    }

    broadcastRoomState(roomId);
  });

  socket.on('message:delete', ({ roomId, messageId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.data.roomId !== roomId) return;

    const removed = deleteMessageById(room, messageId, socket.id);
    if (!removed) return;

    extendRoomExpiry(room);
    broadcastRoomState(roomId);
  });

  socket.on('room:leave', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.data.roomId !== roomId) {
      socket.emit('room:left');
      return;
    }

    const profile = room.users.get(socket.id);
    removeTyping(room, socket.id);
    room.users.delete(socket.id);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.userId = null;

    if (profile?.ip) updateIpRoomCount(profile.ip, -1);

    if (socket.data.typingTimeout) {
      clearTimeout(socket.data.typingTimeout);
      socket.data.typingTimeout = null;
    }

    if (room.type === 'admin' && room.adminSocketId === socket.id) {
      const nextAdmin = room.users.keys().next();
      room.adminSocketId = nextAdmin.done ? null : nextAdmin.value;
    }

    socket.emit('room:left');

    if (room.users.size === 0) {
      destroyRoom(roomId, 'empty');
      return;
    }

    broadcastRoomState(roomId);
  });

  socket.on('room:kill', ({ roomId }) => {
    if (!killLimiter(socket)) return;
    const room = rooms.get(roomId);
    if (!room || socket.data.roomId !== roomId) return;

    const isAllowed = room.type === 'private' || room.adminSocketId === socket.id;
    if (!isAllowed) {
      socket.emit('room:error', { message: 'Only the admin can kill this room.' });
      return;
    }

    destroyRoom(roomId, 'deleted');
  });

  socket.on('disconnect', () => {
    const ip = socket.data.clientIp;
    const current = ipConnectionCounts.get(ip) || 0;
    if (current <= 1) ipConnectionCounts.delete(ip);
    else ipConnectionCounts.set(ip, current - 1);

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const profile = room.users.get(socket.id);
    removeTyping(room, socket.id);
    room.users.delete(socket.id);

    if (profile?.ip) updateIpRoomCount(profile.ip, -1);

    if (socket.data.typingTimeout) {
      clearTimeout(socket.data.typingTimeout);
      socket.data.typingTimeout = null;
    }

    if (room.type === 'admin' && room.adminSocketId === socket.id) {
      const nextAdmin = room.users.keys().next();
      room.adminSocketId = nextAdmin.done ? null : nextAdmin.value;
    }

    if (room.users.size === 0) {
      destroyRoom(roomId, 'empty');
      return;
    }

    broadcastRoomState(roomId);
  });
});

Sentry.setupExpressErrorHandler(app);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      error: 'Image is too large. Keep it under 4 MB before compression.',
    });
  }

  if (error) {
    Sentry.captureException(error);
    return res.status(500).json({ error: 'Unexpected server error.' });
  }

  return res.status(500).json({ error: 'Unexpected server error.' });
});

server.listen(PORT, () => {
  console.log(`HushrChat Secure Beta running on http://localhost:${PORT}`);
});