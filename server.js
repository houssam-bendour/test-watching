const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const roomHosts = new Map();
const roomStates = new Map();
const roomUsers = new Map();

function createInitialState() {
  return {
    videoId: null,
    currentTime: 0,
    isPlaying: false,
    playerType: 'youtube',   // nouveau champ : 'youtube' ou 'direct'
    updatedAt: Date.now()
  };
}

function getRoomState(room) {
  if (!roomStates.has(room)) {
    roomStates.set(room, createInitialState());
  }
  return roomStates.get(room);
}

function getRoomUsers(room) {
  if (!roomUsers.has(room)) {
    roomUsers.set(room, new Map());
  }
  return roomUsers.get(room);
}

function sanitizeProfile(profile = {}) {
  const displayName = String(profile.displayName || 'Invite').trim().slice(0, 28) || 'Invite';
  const avatar = String(profile.avatar || displayName.charAt(0) || 'I').trim().slice(0, 2).toUpperCase();

  return { displayName, avatar };
}

function emitPresence(room) {
  const users = Array.from(getRoomUsers(room).entries()).map(([id, profile]) => ({
    id,
    ...profile,
    isHost: roomHosts.get(room) === id
  }));

  io.in(room).emit('presence-update', {
    users,
    hostId: roomHosts.get(room) || null
  });
}
// ---- Nouvel endpoint pour extraire le flux direct ----
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: 'ID vidéo manquant' });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`📡 Extraction du flux pour : ${videoUrl}`);
  // Chemin vers yt-dlp : d'abord on cherche dans le dossier courant, sinon on tente le PATH
  const localYtDlp = path.join(__dirname, 'yt-dlp.exe');
  const ytDlpCmd = fs.existsSync(localYtDlp) ? localYtDlp : 'yt-dlp';
  console.log(`Utilisation de yt-dlp : ${ytDlpCmd}`);
  // Lancer yt-dlp (doit être présent dans le dossier du projet ou dans le PATH)
const ytDlp = spawn(ytDlpCmd, [
    '-f', 'b',
    '-g',
    '--cookies', 'cookies.txt',
    '--no-warnings',
    videoUrl
]);

  let output = '';
  let errorOutput = '';

  ytDlp.stdout.on('data', (data) => {
    output += data.toString();
  });

  ytDlp.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.error('❌ Erreur yt-dlp :', errorOutput);
      return res.status(500).json({ error: 'Impossible d’extraire le flux vidéo' });
    }

    const streamUrl = output.trim().split('\n')[0]; // première URL
    console.log('✅ URL du flux :', streamUrl.substring(0, 80) + '...');
    res.json({ streamUrl, videoId });
  });

  ytDlp.on('error', (err) => {
    console.error('❌ Erreur spawn yt-dlp :', err);
    res.status(500).json({ error: 'yt-dlp non trouvé ou erreur système' });
  });
});
io.on('connection', (socket) => {
  socket.on('join-room', ({ room, profile }) => {
    const safeRoom = String(room || 'default').trim().slice(0, 64) || 'default';
    const safeProfile = sanitizeProfile(profile);

    socket.data.room = safeRoom;
    socket.data.profile = safeProfile;
    socket.join(safeRoom);

    getRoomUsers(safeRoom).set(socket.id, safeProfile);

    if (!roomHosts.has(safeRoom)) {
      roomHosts.set(safeRoom, socket.id);
    }

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
      socket.emit('control-denied', {
        reason: 'Le controle est verrouille tant que le host actuel est connecte.'
      });
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

    // if (action === 'load' && data.videoId) {
    //   state.videoId = String(data.videoId);
    //   state.currentTime = 0;
    //   state.isPlaying = false;
    // }
    if (action === 'load' && data.videoId) {
      state.videoId = String(data.videoId);
      state.currentTime = 0;
      state.isPlaying = false;
      state.playerType = data.playerType === 'direct' ? 'direct' : 'youtube';   // sauvegarde le type
    }

    if (action === 'seek' && Number.isFinite(currentTime)) {
      state.currentTime = currentTime;
    }

    if (action === 'play') {
      state.isPlaying = true;
      if (Number.isFinite(currentTime)) state.currentTime = currentTime;
    }

    if (action === 'pause') {
      state.isPlaying = false;
      if (Number.isFinite(currentTime)) state.currentTime = currentTime;
    }

    state.updatedAt = Date.now();
    socket.to(safeRoom).emit('player-action', { action, data });
  });

  socket.on('chat-message', ({ room, message }) => {
    const safeRoom = String(room || socket.data.room || 'default');
    const safeMessage = String(message || '').trim().slice(0, 500);
    if (!safeMessage) return;

    io.in(safeRoom).emit('chat-message', {
      message: safeMessage,
      senderId: socket.id,
      sender: socket.data.profile || sanitizeProfile()
    });
  });

  socket.on('gif-message', ({ room, gifUrl }) => {
    const safeRoom = String(room || socket.data.room || 'default');
    const safeGifUrl = String(gifUrl || '').trim();
    if (!safeGifUrl.startsWith('https://')) return;

    io.in(safeRoom).emit('gif-message', {
      gifUrl: safeGifUrl,
      senderId: socket.id,
      sender: socket.data.profile || sanitizeProfile()
    });
  });

  socket.on('offer', ({ room, offer }) => {
    socket.to(String(room || socket.data.room || 'default')).emit('offer', offer);
  });

  socket.on('answer', ({ room, answer }) => {
    socket.to(String(room || socket.data.room || 'default')).emit('answer', answer);
  });

  socket.on('ice-candidate', ({ room, candidate }) => {
    socket.to(String(room || socket.data.room || 'default')).emit('ice-candidate', candidate);
  });

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
  console.log(`Serveur demarre sur http://localhost:${PORT}`);
});
