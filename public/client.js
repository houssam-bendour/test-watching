const GIPHY_API_KEY = 'VOTRE_CLE_GIPHY';
const GIF_LIMIT = 12;
const PROFILE_KEY = 'watchTogetherProfile';

const state = {
  room: null,
  profile: null,
  socket: null,
  player: null,
  playerReady: false,
  amIHost: false,
  hostStatusReceived: false,
  currentHostId: null,
  isRemoteAction: false,
  lastKnownTime: undefined,
  localStream: null,
  peer: null,
  directPlayer: null,
  directPlayerContainer: null,
  currentPlayerType: 'youtube'   // 'youtube' | 'direct'
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  profileScreen:          $('#profile-screen'),
  watchScreen:            $('#watch-screen'),
  profileForm:            $('#profile-form'),
  displayName:            $('#display-name'),
  avatarChoice:           $('#avatar-choice'),
  roomName:               $('#room-name'),
  roomCode:               $('#room-code'),
  roomLabel:              $('#room-label'),
  copyLinkBtn:            $('#copy-link-btn'),
  connectionDot:          $('#connection-dot'),
  connectionStatus:       $('#connection-status'),
  hostBadge:              $('#host-badge'),
  claimHostBtn:           $('#claim-host-btn'),
  playerFrame:            $('.player-frame'),
  playerLock:             $('#player-lock'),
  fullscreenBtn:          $('#fullscreen-btn'),
  videoForm:              $('#video-form'),
  videoUrl:               $('#video-url'),
  videoHelper:            $('#video-helper'),
  startCallBtn:           $('#start-call-btn'),
  hangupBtn:              $('#hangup-btn'),
  callStatus:             $('#call-status'),
  participants:           $('#participants'),
  participantCount:       $('#participant-count'),
  messages:               $('#messages'),
  chatForm:               $('#chat-form'),
  chatInput:              $('#chat-input'),
  emojiBtn:               $('#emoji-btn'),
  emojiPickerContainer:   $('#emoji-picker-container'),
  gifBtn:                 $('#gif-btn'),
  gifPickerContainer:     $('#gif-picker-container')
};

// ════════════════════════════════════════════════════════════════════
//  Utilitaires
// ════════════════════════════════════════════════════════════════════

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function slugifyRoom(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 32);
}

function getRoomFromUrl() {
  return new URLSearchParams(window.location.search).get('room');
}

function setRoomInUrl(room) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', room);
  window.history.replaceState({}, '', url.toString());
}

function loadSavedProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null; } catch { return null; }
}

function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function extractYouTubeId(input) {
  const value = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (host.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || null;
    }
  } catch { return null; }
  return null;
}

// ════════════════════════════════════════════════════════════════════
//  Bootstrap profil
// ════════════════════════════════════════════════════════════════════

function bootstrapProfileForm() {
  const savedProfile = loadSavedProfile();
  const roomFromUrl  = getRoomFromUrl();

  if (savedProfile) {
    elements.displayName.value  = savedProfile.displayName || '';
    elements.avatarChoice.value = savedProfile.avatar || 'Y';
  }
  if (roomFromUrl) elements.roomName.value = roomFromUrl;

  elements.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const displayName    = elements.displayName.value.trim() || 'Invité';
    const avatar         = elements.avatarChoice.value || displayName.charAt(0).toUpperCase();
    const requestedRoom  = slugifyRoom(elements.roomName.value) || roomFromUrl || generateRoomId();

    state.profile = { displayName, avatar };
    state.room    = requestedRoom;
    saveProfile(state.profile);
    setRoomInUrl(state.room);
    showWatchScreen();
    connectSocket();
  });
}

function showWatchScreen() {
  elements.profileScreen.classList.add('hidden');
  elements.watchScreen.classList.remove('hidden');
  elements.roomCode.textContent = state.room;
  elements.roomLabel.textContent = state.profile.displayName;
}

// ════════════════════════════════════════════════════════════════════
//  Socket.io
// ════════════════════════════════════════════════════════════════════

function connectSocket() {
  state.directPlayer          = document.getElementById('direct-player');
  state.directPlayerContainer = document.getElementById('direct-player-container');

  state.socket = io();
  state.socket.emit('join-room', { room: state.room, profile: state.profile });

  state.socket.on('connect',    () => { elements.connectionDot.classList.add('online');    elements.connectionStatus.textContent = 'Connecté'; });
  state.socket.on('disconnect', () => { elements.connectionDot.classList.remove('online'); elements.connectionStatus.textContent = 'Déconnecté'; });

  state.socket.on('host-status', ({ isHost }) => {
    state.amIHost = isHost;
    state.hostStatusReceived = true;
    updateHostUI();
  });

  state.socket.on('new-host', ({ hostId }) => {
    state.currentHostId = hostId;
    state.amIHost = hostId === state.socket.id;
    updateHostUI();
  });

  state.socket.on('presence-update', ({ users, hostId }) => {
    state.currentHostId = hostId;
    state.amIHost = hostId === state.socket.id;
    updateHostUI();
    renderParticipants(users || []);
  });

  state.socket.on('control-denied', ({ reason }) => {
    elements.videoHelper.textContent = reason || 'Le contrôle est réservé au host actuel.';
  });

  state.socket.on('sync-state', (roomState) => {
    if (state.playerReady) applySyncState(roomState);
    else state.pendingSyncState = roomState;
  });

  state.socket.on('player-action', handleRemotePlayerAction);

  state.socket.on('chat-message', ({ message, senderId, sender }) => {
    addMessage({ text: message, sender, isMe: senderId === state.socket.id });
  });
  state.socket.on('gif-message', ({ gifUrl, senderId, sender }) => {
    addMessage({ gifUrl, sender, isMe: senderId === state.socket.id });
  });

  state.socket.on('offer',         handleOffer);
  state.socket.on('answer',        (answer)    => { if (state.peer && !state.peer.destroyed) state.peer.signal(answer); });
  state.socket.on('ice-candidate', (candidate) => { if (state.peer && !state.peer.destroyed) state.peer.signal(candidate); });

  initPlayer();
}

// ════════════════════════════════════════════════════════════════════
//  Host UI
// ════════════════════════════════════════════════════════════════════

function updateHostUI() {
  elements.hostBadge.textContent = state.amIHost ? '🎬 Host' : 'Spectateur';
  elements.hostBadge.classList.toggle('is-host', state.amIHost);
  elements.claimHostBtn.classList.add('hidden');
  elements.playerLock.classList.toggle('hidden', state.amIHost);
  elements.videoUrl.disabled = !state.amIHost;
  elements.videoForm.querySelector('button').disabled = !state.amIHost;
  elements.videoHelper.textContent = state.amIHost
    ? 'Vous contrôlez la vidéo pour toute la room.'
    : 'Le host contrôle la vidéo. Vous restez synchronisé automatiquement.';
}

function renderParticipants(users) {
  if (elements.participantCount) elements.participantCount.textContent = users.length;
  elements.participants.textContent = '';

  users.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'participant' + (user.isHost ? ' is-host' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = user.avatar || user.displayName.charAt(0).toUpperCase();

    const name = document.createElement('small');
    name.textContent = user.id === state.socket.id ? 'Vous' : user.displayName;

    row.append(avatar, name);
    elements.participants.appendChild(row);
  });
}

// ════════════════════════════════════════════════════════════════════
//  Lecteur YouTube
// ════════════════════════════════════════════════════════════════════

function initPlayer() {
  if (window.YT && window.YT.Player) { createPlayer(); return; }
  window.onYouTubeIframeAPIReady = createPlayer;
}

function createPlayer() {
  if (state.player) return;
  state.player = new YT.Player('player', {
    height: '390', width: '640',
    videoId: '',
    playerVars: { autoplay: 0, controls: 1, modestbranding: 1, rel: 0, origin: window.location.origin, enablejsapi: 1 },
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange }
  });
}

function onPlayerReady() {
  state.playerReady = true;
  if (state.pendingSyncState) { applySyncState(state.pendingSyncState); state.pendingSyncState = null; }
}

function onPlayerStateChange(event) {
  if (!state.amIHost || !state.hostStatusReceived || state.isRemoteAction || !state.player) return;
  const action = event.data === YT.PlayerState.PLAYING ? 'play'
               : event.data === YT.PlayerState.PAUSED  ? 'pause'
               : null;
  if (action) {
    state.socket.emit('player-action', { room: state.room, action, data: { currentTime: state.player.getCurrentTime() } });
  }
}

// ════════════════════════════════════════════════════════════════════
//  Synchronisation
// ════════════════════════════════════════════════════════════════════

function switchPlayerTypeUI(type) {
  const youtubeDiv = document.getElementById('player');
  const directDiv  = document.getElementById('direct-player-container');
  if (type === 'direct') {
    youtubeDiv.style.display = 'none';
    directDiv.style.display  = 'block';
  } else {
    youtubeDiv.style.display = 'block';
    directDiv.style.display  = 'none';
  }
}

function applySyncState(roomState) {
  if (!roomState) return;

  const newType = roomState.playerType || 'youtube';
  if (newType !== state.currentPlayerType) {
    state.currentPlayerType = newType;
    switchPlayerTypeUI(newType);
  }

  if (state.currentPlayerType === 'direct' && state.directPlayer) {
    if (roomState.videoId && !state.directPlayer.src.includes(encodeURIComponent(roomState.videoId))) {
      loadDirectStream(roomState.videoId);
    }
    state.directPlayer.currentTime = roomState.currentTime || 0;
    if (roomState.isPlaying) state.directPlayer.play().catch(() => {});
    else state.directPlayer.pause();
  } else if (state.player && state.playerReady) {
    runRemotePlayerAction(() => {
      if (roomState.videoId) state.player.loadVideoById(roomState.videoId, roomState.currentTime || 0);
      else state.player.seekTo(roomState.currentTime || 0, true);
      if (roomState.isPlaying) state.player.playVideo();
      else state.player.pauseVideo();
    });
  }
}

function handleRemotePlayerAction({ action, data = {} }) {
  if (!state.player && !state.directPlayer) return;

  runRemotePlayerAction(() => {
    if (action === 'load' && data.videoId) {
      const playerType = data.playerType || 'youtube';
      if (playerType !== state.currentPlayerType) {
        state.currentPlayerType = playerType;
        switchPlayerTypeUI(playerType);
      }
      if (playerType === 'direct') {
        loadDirectStream(data.videoId);
      } else if (state.player) {
        state.player.loadVideoById(data.videoId);
      }
      return;
    }

    if (state.currentPlayerType === 'direct' && state.directPlayer) {
      if (action === 'play')  { if (Number.isFinite(data.currentTime)) state.directPlayer.currentTime = data.currentTime; state.directPlayer.play().catch(() => {}); }
      if (action === 'pause') { if (Number.isFinite(data.currentTime)) state.directPlayer.currentTime = data.currentTime; state.directPlayer.pause(); }
      if (action === 'seek')  { state.directPlayer.currentTime = data.currentTime || 0; }
    } else if (state.player) {
      if (action === 'play')  { if (Number.isFinite(data.currentTime)) state.player.seekTo(data.currentTime, true); state.player.playVideo(); }
      if (action === 'pause') { if (Number.isFinite(data.currentTime)) state.player.seekTo(data.currentTime, true); state.player.pauseVideo(); }
      if (action === 'seek')  { state.player.seekTo(data.currentTime || 0, true); }
    }
  });
}

function runRemotePlayerAction(callback) {
  state.isRemoteAction = true;
  try { callback(); } finally { window.setTimeout(() => { state.isRemoteAction = false; }, 250); }
}

// ════════════════════════════════════════════════════════════════════
//  Flux direct — PROXY SERVEUR (résout le CORS)
//
//  Au lieu d'exposer l'URL googlevideo.com au navigateur,
//  on charge /api/proxy?id=VIDEO_ID qui proxifie côté serveur.
//  Plus besoin de HLS.js — c'est un MP4 direct via <video>.
// ════════════════════════════════════════════════════════════════════

async function loadDirectStream(videoId) {
  // Nettoyer une ancienne instance HLS si elle traîne encore
  if (window.hlsInstance) { window.hlsInstance.destroy(); window.hlsInstance = null; }

  if (!state.directPlayer) state.directPlayer = document.getElementById('direct-player');
  if (!state.directPlayerContainer) state.directPlayerContainer = document.getElementById('direct-player-container');

  switchPlayerTypeUI('direct');

  try {
    // ► Le serveur proxifie le flux : aucune URL YouTube CDN n'atteint le navigateur.
    const proxyUrl = `/api/proxy?id=${encodeURIComponent(videoId)}`;

    state.directPlayer.src = proxyUrl;
    state.directPlayer.load();

    // Retirer les anciens listeners pour éviter les doublons
    state.directPlayer.onplay   = null;
    state.directPlayer.onpause  = null;
    state.directPlayer.onseeked = null;

    if (state.amIHost) {
      state.directPlayer.onplay = () => {
        if (!state.amIHost || state.isRemoteAction) return;
        state.socket.emit('player-action', { room: state.room, action: 'play',  data: { currentTime: state.directPlayer.currentTime } });
      };
      state.directPlayer.onpause = () => {
        if (!state.amIHost || state.isRemoteAction) return;
        state.socket.emit('player-action', { room: state.room, action: 'pause', data: { currentTime: state.directPlayer.currentTime } });
      };
      state.directPlayer.onseeked = () => {
        if (!state.amIHost || state.isRemoteAction) return;
        state.socket.emit('player-action', { room: state.room, action: 'seek',  data: { currentTime: state.directPlayer.currentTime } });
      };
    }

    state.currentPlayerType = 'direct';
    return true;
  } catch (err) {
    console.error('❌ loadDirectStream:', err);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════
//  Contrôles UI
// ════════════════════════════════════════════════════════════════════

function wireControls() {
  elements.copyLinkBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(window.location.href);
    const orig = elements.copyLinkBtn.textContent;
    elements.copyLinkBtn.textContent = '✓ Copié !';
    window.setTimeout(() => { elements.copyLinkBtn.textContent = orig; }, 1400);
  });

  elements.fullscreenBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await elements.playerFrame.requestFullscreen();
    } catch {
      elements.videoHelper.textContent = 'Plein écran indisponible dans ce navigateur.';
    }
  });

  elements.claimHostBtn.addEventListener('click', () => {
    state.socket.emit('claim-host', state.room);
  });

  elements.videoForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.amIHost) return;

    const videoId = extractYouTubeId(elements.videoUrl.value);
    if (!videoId) {
      elements.videoHelper.textContent = '⚠️ Lien YouTube invalide (youtube.com/watch, youtu.be ou Shorts).';
      return;
    }

    elements.videoHelper.textContent = '⏳ Chargement du flux…';

    // Tenter le flux direct via proxy serveur
    const directLoaded = await loadDirectStream(videoId);
    const playerType   = directLoaded ? 'direct' : 'youtube';

    state.socket.emit('player-action', {
      room: state.room, action: 'load',
      data: { videoId, playerType }
    });

    if (!directLoaded) {
      // Fallback lecteur YouTube intégré
      state.currentPlayerType = 'youtube';
      switchPlayerTypeUI('youtube');
      if (state.player && state.playerReady) state.player.loadVideoById(videoId);
      elements.videoHelper.textContent = 'Vidéo chargée (lecteur YouTube).';
    } else {
      elements.videoHelper.textContent = 'Vidéo chargée via flux direct ✓';
    }
  });

  // Détection de seek (host uniquement, toutes les secondes)
  window.setInterval(() => {
    if (!state.amIHost || !state.hostStatusReceived || state.isRemoteAction) return;

    let currentTime;
    if (state.currentPlayerType === 'direct' && state.directPlayer) {
      currentTime = state.directPlayer.currentTime;
    } else if (state.playerReady && state.player) {
      currentTime = state.player.getCurrentTime();
    } else return;

    if (state.lastKnownTime !== undefined && Math.abs(currentTime - state.lastKnownTime) > 1.5) {
      state.socket.emit('player-action', { room: state.room, action: 'seek', data: { currentTime } });
    }
    state.lastKnownTime = currentTime;
  }, 1000);

  elements.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = elements.chatInput.value.trim();
    if (!text) return;
    state.socket.emit('chat-message', { room: state.room, message: text });
    elements.chatInput.value = '';
  });

  wireEmojiPicker();
  wireGifPicker();
  wireCallControls();
}

// ════════════════════════════════════════════════════════════════════
//  Messages chat
// ════════════════════════════════════════════════════════════════════

function addMessage({ text, gifUrl, sender, isMe }) {
  const message = document.createElement('div');
  message.className = `message${isMe ? ' is-me' : ''}`;

  const meta = document.createElement('span');
  meta.className = 'message-meta';
  meta.textContent = isMe ? 'Vous' : sender?.displayName || 'Invité';
  message.appendChild(meta);

  if (gifUrl) {
    const img = document.createElement('img');
    img.className = 'chat-gif'; img.src = gifUrl; img.alt = 'GIF';
    message.appendChild(img);
  } else {
    const body = document.createElement('span');
    body.textContent = text;
    message.appendChild(body);
  }

  elements.messages.appendChild(message);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// ════════════════════════════════════════════════════════════════════
//  Emoji picker
// ════════════════════════════════════════════════════════════════════

function wireEmojiPicker() {
  customElements.whenDefined('emoji-picker').then(() => {
    const picker = document.createElement('emoji-picker');
    picker.addEventListener('emoji-click', (event) => {
      elements.chatInput.value += event.detail.unicode;
      elements.chatInput.focus();
      elements.emojiPickerContainer.classList.add('hidden');
    });
    elements.emojiPickerContainer.appendChild(picker);
  });

  elements.emojiBtn.addEventListener('click', () => {
    elements.emojiPickerContainer.classList.toggle('hidden');
    elements.gifPickerContainer.classList.add('hidden');
  });
}

// ════════════════════════════════════════════════════════════════════
//  GIF picker
// ════════════════════════════════════════════════════════════════════

function wireGifPicker() {
  elements.gifBtn.addEventListener('click', () => {
    elements.gifPickerContainer.classList.toggle('hidden');
    elements.emojiPickerContainer.classList.add('hidden');
    if (!elements.gifPickerContainer.classList.contains('hidden')) loadTrendingGifs();
  });
}

async function loadTrendingGifs() {
  if (GIPHY_API_KEY === 'VOTRE_CLE_GIPHY') {
    elements.gifPickerContainer.textContent = 'Ajoutez une clé Giphy dans client.js pour activer les GIFs.';
    return;
  }
  elements.gifPickerContainer.textContent = 'Chargement…';
  try {
    const r = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${GIF_LIMIT}&rating=g`);
    const json = await r.json();
    displayGifs(json.data || []);
  } catch {
    elements.gifPickerContainer.textContent = 'Impossible de charger les GIFs.';
  }
}

function displayGifs(gifs) {
  elements.gifPickerContainer.textContent = '';
  const search = document.createElement('form');
  search.className = 'gif-search';
  const input = document.createElement('input');
  input.placeholder = 'Rechercher un GIF';
  const button = document.createElement('button');
  button.className = 'secondary-btn'; button.type = 'submit'; button.textContent = 'OK';
  search.append(input, button);
  search.addEventListener('submit', (event) => { event.preventDefault(); searchGifs(input.value); });

  const grid = document.createElement('div');
  grid.className = 'gif-grid';
  gifs.forEach((gif) => {
    const img = document.createElement('img');
    img.className = 'gif-thumb';
    img.src = gif.images.fixed_height_small.url;
    img.alt = gif.title || 'GIF';
    img.addEventListener('click', () => {
      state.socket.emit('gif-message', { room: state.room, gifUrl: gif.images.original.url });
      elements.gifPickerContainer.classList.add('hidden');
    });
    grid.appendChild(img);
  });

  elements.gifPickerContainer.append(search, grid);
}

async function searchGifs(query) {
  if (!query.trim()) return;
  elements.gifPickerContainer.textContent = 'Recherche…';
  try {
    const r = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=${GIF_LIMIT}&rating=g`);
    const json = await r.json();
    displayGifs(json.data || []);
  } catch {
    elements.gifPickerContainer.textContent = 'Recherche impossible.';
  }
}

// ════════════════════════════════════════════════════════════════════
//  Appel audio WebRTC
// ════════════════════════════════════════════════════════════════════

function wireCallControls() {
  elements.startCallBtn.addEventListener('click', async () => {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      elements.startCallBtn.disabled = true;
      elements.callStatus.textContent = 'Appel en cours…';
      createPeer(true);
    } catch (error) {
      elements.callStatus.textContent = 'Micro indisponible';
      console.error(error);
    }
  });

  elements.hangupBtn.addEventListener('click', endCall);
}

function createPeer(initiator) {
  state.peer = new SimplePeer({
    initiator,
    stream: state.localStream,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  });

  state.peer.on('signal', (data) => {
    if (data.type === 'offer')      state.socket.emit('offer',         { room: state.room, offer: data });
    else if (data.type === 'answer') state.socket.emit('answer',        { room: state.room, answer: data });
    else if (data.candidate)         state.socket.emit('ice-candidate', { room: state.room, candidate: data });
  });

  state.peer.on('stream', (remoteStream) => {
    const audio = new Audio();
    audio.srcObject = remoteStream;
    audio.play().catch(console.error);
    elements.hangupBtn.disabled = false;
    elements.callStatus.textContent = 'Audio connecté';
  });

  state.peer.on('error', console.error);
  state.peer.on('close', endCall);
}

async function handleOffer(offer) {
  if (state.peer) return;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    elements.startCallBtn.disabled = true;
    elements.callStatus.textContent = 'Appel entrant…';
    createPeer(false);
    state.peer.signal(offer);
  } catch (error) {
    elements.callStatus.textContent = 'Micro indisponible';
    console.error(error);
  }
}

function endCall() {
  if (state.peer && !state.peer.destroyed) state.peer.destroy();
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  state.peer = null;
  state.localStream = null;
  elements.startCallBtn.disabled = false;
  elements.hangupBtn.disabled = true;
  elements.callStatus.textContent = 'Audio inactif';
}

// ════════════════════════════════════════════════════════════════════
//  Init
// ════════════════════════════════════════════════════════════════════

bootstrapProfileForm();
wireControls();