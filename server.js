const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
 
const express = require('express');
const httpServer = require('http');
const { Server } = require('socket.io');
 
const app = express();
const server = httpServer.createServer(app);
const io = new Server(server);
 
app.use(express.static('public'));
 
const roomHosts = new Map();
const roomStates = new Map();
const roomUsers = new Map();
 
// ── Cache des URLs de flux (les URLs YouTube expirent ~6h) ──────────────────
const streamUrlCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 heures
 
function getYtDlpCmd() {
  const localExe = path.join(__dirname, 'yt-dlp.exe');
  const localBin = path.join(__dirname, 'yt-dlp');
  if (fs.existsSync(localExe)) return localExe;
  if (fs.existsSync(localBin)) return localBin;
  return 'yt-dlp';
}
 
/**
 * Appelle yt-dlp et retourne l'URL directe du flux.
 * Résultat mis en cache pour éviter des appels répétés.
 */
function fetchStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const cached = streamUrlCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`📦 Cache hit pour ${videoId}`);
      return resolve(cached.url);
    }
 
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const ytDlpCmd = getYtDlpCmd();
    console.log(`📡 yt-dlp extraction: ${videoUrl}`);
 
    const args = ['-f', 'b', '-g', '--no-warnings', videoUrl];
 
    // Ajouter les cookies seulement si le fichier existe
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
      args.splice(args.length - 1, 0, '--cookies', cookiesPath);
    }
 
    const ytDlp = spawn(ytDlpCmd, args);
    let output = '';
    let errorOutput = '';
 
    ytDlp.stdout.on('data', (data) => { output += data.toString(); });
    ytDlp.stderr.on('data', (data) => { errorOutput += data.toString(); });
 
    ytDlp.on('close', (code) => {
      if (code !== 0) {
        console.error('❌ yt-dlp error:', errorOutput);
        return reject(new Error(errorOutput || 'yt-dlp a échoué'));
      }
      const url = output.trim().split('\n')[0];
      if (!url) return reject(new Error('yt-dlp: aucune URL retournée'));
 
      console.log('✅ URL extraite (début):', url.substring(0, 80) + '...');
      streamUrlCache.set(videoId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
      resolve(url);
    });
 
    ytDlp.on('error', (err) => {
      console.error('❌ spawn yt-dlp:', err);
      reject(err);
    });
  });
}
 
// ── /api/stream — retourne uniquement les métadonnées (rétrocompat.) ────────
app.get('/api/stream', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).json({ error: 'ID vidéo manquant' });
 
  try {
    await fetchStreamUrl(videoId); // pré-chauffe le cache
    res.json({ proxyUrl: `/api/proxy?id=${videoId}`, videoId });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Extraction impossible' });
  }
});
 
// ── /api/proxy — proxifie le flux vidéo côté serveur (résout le CORS) ──────
//
//  Le navigateur ne voit jamais l'URL googlevideo.com.
//  Supporte les Range requests pour que la seekbar fonctionne.
//
app.get('/api/proxy', async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) return res.status(400).send('ID manquant');
 
  let streamUrl;
  try {
    streamUrl = await fetchStreamUrl(videoId);
  } catch (err) {
    console.error('Proxy — impossible d\'obtenir l\'URL:', err.message);
    return res.status(500).send('Impossible d\'extraire le flux : ' + err.message);
  }
 
  /**
   * Fait une requête HTTP(S) vers upstream avec support des redirections.
   * Retourne la réponse finale après redirections.
   */
  function fetchUpstream(targetUrl, reqHeaders, redirectCount = 0) {
    if (redirectCount > 5) return Promise.reject(new Error('Trop de redirections'));
 
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try { parsedUrl = new URL(targetUrl); } catch (e) { return reject(e); }
 
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.youtube.com/',
          ...reqHeaders
        }
      };
 
      const upstreamReq = lib.request(options, (upstream) => {
        // Suivre les redirects 301/302/307/308
        if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
          upstream.resume(); // vider le buffer
          resolve(fetchUpstream(upstream.headers.location, reqHeaders, redirectCount + 1));
          return;
        }
        resolve(upstream);
      });
 
      upstreamReq.on('error', reject);
      upstreamReq.setTimeout(15000, () => {
        upstreamReq.destroy(new Error('Timeout upstream'));
      });
      upstreamReq.end();
    });
  }
 
  try {
    const rangeHeader = req.headers.range ? { Range: req.headers.range } : {};
    const upstream = await fetchUpstream(streamUrl, rangeHeader);
 
    // Headers CORS + vidéo
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
 
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', upstream.headers['content-range']);
    }
    if (upstream.headers['cache-control']) {
      res.setHeader('Cache-Control', upstream.headers['cache-control']);
    }
 
    res.status(upstream.statusCode);
 
    // Annuler le upstream si le client se déconnecte
    req.on('close', () => upstream.destroy());
 
    upstream.pipe(res);
  } catch (err) {
    console.error('Erreur proxy:', err.message);
    if (!res.headersSent) {
      res.status(502).send('Erreur proxy: ' + err.message);
    }
  }
});
 
// ════════════════════════════════════════════════════════════════════
//  Socket.io — logique de room (inchangée)
// ════════════════════════════════════════════════════════════════════
 
function createInitialState() {
  return {
    videoId: null,
    currentTime: 0,
    isPlaying: false,
    playerType: 'youtube',
    updatedAt: Date.now()
  };
}
 
function getRoomState(room) {
  if (!roomStates.has(room)) roomStates.set(room, createInitialState());
  return roomStates.get(room);
}
 
function getRoomUsers(room) {
  if (!roomUsers.has(room)) roomUsers.set(room, new Map());
  return roomUsers.get(room);
}
 
function sanitizeProfile(profile = {}) {
  const displayName = String(profile.displayName || 'Invité').trim().slice(0, 28) || 'Invité';
  const avatar = String(profile.avatar || displayName.charAt(0) || 'I').trim().slice(0, 2).toUpperCase();
  return { displayName, avatar };
}
 
function emitPresence(room) {
  const users = Array.from(getRoomUsers(room).entries()).map(([id, profile]) => ({
    id,
    ...profile,
    isHost: roomHosts.get(room) === id
  }));
  io.in(room).emit('presence-update', { users, hostId: roomHosts.get(room) || null });
}
 
io.on('connection', (socket) => {
  socket.on('join-room', ({ room, profile }) => {
    const safeRoom = String(room || 'default').trim().slice(0, 64) || 'default';
    const safeProfile = sanitizeProfile(profile);
 
    socket.data.room = safeRoom;
    socket.data.profile = safeProfile;
    socket.join(safeRoom);
    getRoomUsers(safeRoom).set(socket.id, safeProfile);
 
    if (!roomHosts.has(safeRoom)) roomHosts.set(safeRoom, socket.id);
 
    socket.emit('host-status', { isHost: roomHosts.get(safeRoom) === socket.id });
    socket.emit('sync-state', getRoomState(safeRoom));
    emitPresence(safeRoom);
  });
 
  socket.on('claim-host', (room) => {
    const safeRoom = String(room || socket.data.room || 'default');
    const users = getRoomUsers(safeRoom);
    if (!users.has(socket.id)) return;
 
    const currentHost = roomHosts.get(safeRoom);
    if (currentHost && currentHost !== socket.id && users.has(currentHost)) {
      socket.emit('control-denied', { reason: 'Le contrôle est verrouillé tant que le host actuel est connecté.' });
      return;
    }
 
    roomHosts.set(safeRoom, socket.id);
    io.in(safeRoom).emit('new-host', { hostId: socket.id });
    emitPresence(safeRoom);
  });
 
  socket.on('player-action', ({ room, action, data = {} }) => {
    const safeRoom = String(room || socket.data.room || 'default');
    if (roomHosts.get(safeRoom) !== socket.id) return;
 
    const state = getRoomState(safeRoom);
    const currentTime = Number(data.currentTime);
 
    if (action === 'load' && data.videoId) {
      state.videoId = String(data.videoId);
      state.currentTime = 0;
      state.isPlaying = false;
      state.playerType = data.playerType === 'direct' ? 'direct' : 'youtube';
    }
    if (action === 'seek' && Number.isFinite(currentTime)) state.currentTime = currentTime;
    if (action === 'play') { state.isPlaying = true; if (Number.isFinite(currentTime)) state.currentTime = currentTime; }
    if (action === 'pause') { state.isPlaying = false; if (Number.isFinite(currentTime)) state.currentTime = currentTime; }
 
    state.updatedAt = Date.now();
    socket.to(safeRoom).emit('player-action', { action, data });
  });
 
  socket.on('chat-message', ({ room, message }) => {
    const safeRoom = String(room || socket.data.room || 'default');
    const safeMessage = String(message || '').trim().slice(0, 500);
    if (!safeMessage) return;
    io.in(safeRoom).emit('chat-message', { message: safeMessage, senderId: socket.id, sender: socket.data.profile || sanitizeProfile() });
  });
 
  socket.on('gif-message', ({ room, gifUrl }) => {
    const safeRoom = String(room || socket.data.room || 'default');
    const safeGifUrl = String(gifUrl || '').trim();
    if (!safeGifUrl.startsWith('https://')) return;
    io.in(safeRoom).emit('gif-message', { gifUrl: safeGifUrl, senderId: socket.id, sender: socket.data.profile || sanitizeProfile() });
  });
 
  socket.on('offer', ({ room, offer }) => { socket.to(String(room || socket.data.room || 'default')).emit('offer', offer); });
  socket.on('answer', ({ room, answer }) => { socket.to(String(room || socket.data.room || 'default')).emit('answer', answer); });
  socket.on('ice-candidate', ({ room, candidate }) => { socket.to(String(room || socket.data.room || 'default')).emit('ice-candidate', candidate); });
 
  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (!room) return;
 
    getRoomUsers(room).delete(socket.id);
 
    if (roomHosts.get(room) === socket.id) {
      const nextHost = getRoomUsers(room).keys().next().value;
      if (nextHost) {
        roomHosts.set(room, nextHost);
        io.in(room).emit('new-host', { hostId: nextHost });
      } else {
        roomHosts.delete(room);
        roomStates.delete(room);
      }
    }
 
    if (getRoomUsers(room).size === 0) {
      roomUsers.delete(room);
    } else {
      emitPresence(room);
    }
  });
});
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur http://localhost:${PORT}`);
});