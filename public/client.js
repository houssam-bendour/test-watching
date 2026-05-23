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
  // Propriétés pour le flux direct (yt-dlp)
  directPlayer: null,
  directPlayerContainer: null,
  useDirectStream: false,
  lastPlayerType: 'youtube' ,// 'youtube' ou 'direct'
  currentPlayerType: 'youtube'   // 'youtube' ou 'direct'
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  profileScreen: $('#profile-screen'),
  watchScreen: $('#watch-screen'),
  profileForm: $('#profile-form'),
  displayName: $('#display-name'),
  avatarChoice: $('#avatar-choice'),
  roomName: $('#room-name'),
  roomCode: $('#room-code'),
  roomLabel: $('#room-label'),
  copyLinkBtn: $('#copy-link-btn'),
  connectionDot: $('#connection-dot'),
  connectionStatus: $('#connection-status'),
  hostBadge: $('#host-badge'),
  claimHostBtn: $('#claim-host-btn'),
  playerFrame: $('.player-frame'),
  playerLock: $('#player-lock'),
  fullscreenBtn: $('#fullscreen-btn'),
  videoForm: $('#video-form'),
  videoUrl: $('#video-url'),
  videoHelper: $('#video-helper'),
  startCallBtn: $('#start-call-btn'),
  hangupBtn: $('#hangup-btn'),
  callStatus: $('#call-status'),
  participants: $('#participants'),
  participantCount: $('#participant-count'),
  messages: $('#messages'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  emojiBtn: $('#emoji-btn'),
  emojiPickerContainer: $('#emoji-picker-container'),
  gifBtn: $('#gif-btn'),
  gifPickerContainer: $('#gif-picker-container')
};

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function slugifyRoom(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

function getRoomFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('room');
}

function setRoomInUrl(room) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', room);
  window.history.replaceState({}, '', url.toString());
}

function loadSavedProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY)) || null;
  } catch {
    return null;
  }
}

function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function bootstrapProfileForm() {
  const savedProfile = loadSavedProfile();
  const roomFromUrl = getRoomFromUrl();

  if (savedProfile) {
    elements.displayName.value = savedProfile.displayName || '';
    elements.avatarChoice.value = savedProfile.avatar || 'Y';
  }

  if (roomFromUrl) {
    elements.roomName.value = roomFromUrl;
  }

  elements.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const displayName = elements.displayName.value.trim() || 'Invite';
    const avatar = elements.avatarChoice.value || displayName.charAt(0).toUpperCase();
    const requestedRoom = slugifyRoom(elements.roomName.value) || roomFromUrl || generateRoomId();

    state.profile = { displayName, avatar };
    state.room = requestedRoom;
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

function connectSocket() {
  // Récupération des éléments pour le lecteur direct (une fois le DOM chargé)
  state.directPlayer = document.getElementById('direct-player');
  state.directPlayerContainer = document.getElementById('direct-player-container');

  state.socket = io();
  state.socket.emit('join-room', {
    room: state.room,
    profile: state.profile
  });

  state.socket.on('connect', () => {
    elements.connectionDot.classList.add('online');
    elements.connectionStatus.textContent = 'Connecte';
  });

  state.socket.on('disconnect', () => {
    elements.connectionDot.classList.remove('online');
    elements.connectionStatus.textContent = 'Deconnecte';
  });

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
    elements.videoHelper.textContent = reason || 'Le controle est reserve au host actuel.';
  });

  state.socket.on('sync-state', (roomState) => {
    if (state.playerReady) {
      applySyncState(roomState);
    } else {
      state.pendingSyncState = roomState;
    }
  });

  state.socket.on('player-action', handleRemotePlayerAction);
  state.socket.on('chat-message', ({ message, senderId, sender }) => {
    addMessage({ text: message, sender, isMe: senderId === state.socket.id });
  });
  state.socket.on('gif-message', ({ gifUrl, senderId, sender }) => {
    addMessage({ gifUrl, sender, isMe: senderId === state.socket.id });
  });
  state.socket.on('offer', handleOffer);
  state.socket.on('answer', (answer) => {
    if (state.peer && !state.peer.destroyed) state.peer.signal(answer);
  });
  state.socket.on('ice-candidate', (candidate) => {
    if (state.peer && !state.peer.destroyed) state.peer.signal(candidate);
  });

  initPlayer();
}

function updateHostUI() {
  elements.hostBadge.textContent = state.amIHost ? 'Host' : 'Spectateur';
  elements.hostBadge.classList.toggle('is-host', state.amIHost);
  elements.claimHostBtn.classList.add('hidden');
  elements.playerLock.classList.toggle('hidden', state.amIHost);
  elements.videoUrl.disabled = !state.amIHost;
  elements.videoForm.querySelector('button').disabled = !state.amIHost;
  elements.videoHelper.textContent = state.amIHost
    ? 'Vous controlez la video pour toute la room.'
    : 'Le host controle la video. Vous restez synchronise automatiquement.';
}

function renderParticipants(users) {
  elements.participantCount.textContent = users.length;
  elements.participants.textContent = '';

  users.forEach((user) => {
    const row = document.createElement('div');
    row.className = 'participant';

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = user.avatar || user.displayName.charAt(0).toUpperCase();

    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = user.id === state.socket.id ? `${user.displayName} (vous)` : user.displayName;
    const role = document.createElement('small');
    role.textContent = user.isHost ? 'Host' : 'Spectateur';

    text.append(name, document.createElement('br'), role);
    row.append(avatar, text);
    elements.participants.appendChild(row);
  });
}

function extractYouTubeId(input) {
  const value = String(input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || null;
    }

    if (host.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || null;
    }
  } catch {
    return null;
  }

  return null;
}

function initPlayer() {
  if (window.YT && window.YT.Player) {
    createPlayer();
    return;
  }

  window.onYouTubeIframeAPIReady = createPlayer;
}

function createPlayer() {
  if (state.player) return;

  state.player = new YT.Player('player', {
    height: '390',
    width: '640',
    videoId: 'M7lc1UVf-VE',
    playerVars: {
      autoplay: 0,
      controls: 1,
      modestbranding: 1,
      rel: 0,
      origin: window.location.origin,
      enablejsapi: 1
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange
    }
  });
}

function onPlayerReady() {
  state.playerReady = true;
  if (state.pendingSyncState) {
    applySyncState(state.pendingSyncState);
    state.pendingSyncState = null;
  }
}

function onPlayerStateChange(event) {
  if (!state.amIHost || !state.hostStatusReceived || state.isRemoteAction || !state.player) return;

  const playerState = event.data;
  const action = playerState === YT.PlayerState.PLAYING
    ? 'play'
    : playerState === YT.PlayerState.PAUSED
      ? 'pause'
      : null;

  if (action) {
    state.socket.emit('player-action', {
      room: state.room,
      action,
      data: { currentTime: state.player.getCurrentTime() }
    });
  }
}

// function applySyncState(roomState) {
//   if (!roomState) return;

//   if (state.useDirectStream && state.directPlayer) {
//     // Mode direct
//     state.directPlayer.currentTime = roomState.currentTime || 0;
//     if (roomState.isPlaying) state.directPlayer.play();
//     else state.directPlayer.pause();
//   } else if (state.player && state.playerReady) {
//     // Lecteur YouTube
//     runRemotePlayerAction(() => {
//       if (roomState.videoId) {
//         state.player.loadVideoById(roomState.videoId, roomState.currentTime || 0);
//       } else {
//         state.player.seekTo(roomState.currentTime || 0, true);
//       }
//       if (roomState.isPlaying) state.player.playVideo();
//       else state.player.pauseVideo();
//     });
//   }
// }
function applySyncState(roomState) {
  if (!roomState) return;

  // Mémoriser le type de lecteur actuel
  const newPlayerType = roomState.playerType || 'youtube';
  if (newPlayerType !== state.currentPlayerType) {
    state.currentPlayerType = newPlayerType;
    switchPlayerTypeUI(newPlayerType);   // bascule l'affichage des conteneurs
  }

  if (state.currentPlayerType === 'direct' && state.directPlayer) {
    // Mode direct : charger/synchroniser
    if (roomState.videoId && (!state.directPlayer.src || !state.directPlayer.src.includes(roomState.videoId))) {
      loadDirectStream(roomState.videoId);
    }
    state.directPlayer.currentTime = roomState.currentTime || 0;
    if (roomState.isPlaying) state.directPlayer.play();
    else state.directPlayer.pause();
  } else if (state.player && state.playerReady) {
    // Mode YouTube
    runRemotePlayerAction(() => {
      if (roomState.videoId) {
        state.player.loadVideoById(roomState.videoId, roomState.currentTime || 0);
      } else {
        state.player.seekTo(roomState.currentTime || 0, true);
      }
      if (roomState.isPlaying) state.player.playVideo();
      else state.player.pauseVideo();
    });
  }
}
function switchPlayerTypeUI(type) {
  const youtubeContainer = document.getElementById('player');
  const directContainer = document.getElementById('direct-player-container');
  if (type === 'direct') {
    youtubeContainer.style.display = 'none';
    directContainer.style.display = 'block';
  } else {
    youtubeContainer.style.display = 'block';
    directContainer.style.display = 'none';
  }
}

// function handleRemotePlayerAction({ action, data = {} }) {
//   if (!state.player && !state.directPlayer) return;

//   runRemotePlayerAction(() => {
//     if (state.useDirectStream && state.directPlayer) {
//       // Contrôler le lecteur direct
//       if (action === 'load' && data.videoId) {
//         loadDirectStream(data.videoId);
//       } else if (action === 'play') {
//         if (Number.isFinite(data.currentTime)) state.directPlayer.currentTime = data.currentTime;
//         state.directPlayer.play();
//       } else if (action === 'pause') {
//         if (Number.isFinite(data.currentTime)) state.directPlayer.currentTime = data.currentTime;
//         state.directPlayer.pause();
//       } else if (action === 'seek') {
//         state.directPlayer.currentTime = data.currentTime || 0;
//       }
//     } else if (state.player) {
//       // Contrôler le lecteur YouTube
//       if (action === 'load' && data.videoId) state.player.loadVideoById(data.videoId);
//       if (action === 'seek') state.player.seekTo(data.currentTime || 0, true);
//       if (action === 'play') {
//         if (Number.isFinite(data.currentTime)) state.player.seekTo(data.currentTime, true);
//         state.player.playVideo();
//       }
//       if (action === 'pause') {
//         if (Number.isFinite(data.currentTime)) state.player.seekTo(data.currentTime, true);
//         state.player.pauseVideo();
//       }
//     }
//   });
// }
function handleRemotePlayerAction({ action, data = {} }) {
  if (!state.player && !state.directPlayer) return;

  runRemotePlayerAction(() => {
    if (action === 'load' && data.videoId) {
      const playerType = data.playerType || 'youtube';
      // Mise à jour du type de lecteur
      if (playerType !== state.currentPlayerType) {
        state.currentPlayerType = playerType;
        switchPlayerTypeUI(playerType);
      }
      if (playerType === 'direct') {
        loadDirectStream(data.videoId);
      } else if (state.player) {
        state.player.loadVideoById(data.videoId);
      }
    } else if (action === 'play') {
      if (state.currentPlayerType === 'direct' && state.directPlayer) {
        if (Number.isFinite(data.currentTime)) state.directPlayer.currentTime = data.currentTime;
        state.directPlayer.play();
      } else if (state.player) {
        if (Number.isFinite(data.currentTime)) state.player.seekTo(data.currentTime, true);
        state.player.playVideo();
      }
    } else if (action === 'pause') {
      if (state.currentPlayerType === 'direct' && state.directPlayer) {
        if (Number.isFinite(data.currentTime)) state.directPlayer.currentTime = data.currentTime;
        state.directPlayer.pause();
      } else if (state.player) {
        if (Number.isFinite(data.currentTime)) state.player.seekTo(data.currentTime, true);
        state.player.pauseVideo();
      }
    } else if (action === 'seek') {
      if (state.currentPlayerType === 'direct' && state.directPlayer) {
        state.directPlayer.currentTime = data.currentTime || 0;
      } else if (state.player) {
        state.player.seekTo(data.currentTime || 0, true);
      }
    }
  });
}

function runRemotePlayerAction(callback) {
  state.isRemoteAction = true;
  try {
    callback();
  } finally {
    window.setTimeout(() => {
      state.isRemoteAction = false;
    }, 250);
  }
}

function wireControls() {
  // Ces éléments peuvent aussi être récupérés ici (ils sont déjà dans state, mais on les redéfinit au cas où)
  if (!state.directPlayer) state.directPlayer = document.getElementById('direct-player');
  if (!state.directPlayerContainer) state.directPlayerContainer = document.getElementById('direct-player-container');

  elements.copyLinkBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(window.location.href);
    elements.copyLinkBtn.textContent = 'Lien copie';
    window.setTimeout(() => {
      elements.copyLinkBtn.textContent = 'Copier le lien';
    }, 1400);
  });

  elements.fullscreenBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await elements.playerFrame.requestFullscreen();
      }
    } catch {
      elements.videoHelper.textContent = 'Le plein ecran est indisponible dans ce navigateur.';
    }
  });

  elements.claimHostBtn.addEventListener('click', () => {
    state.socket.emit('claim-host', state.room);
  });

  // elements.videoForm.addEventListener('submit', async (event) => {
  //   event.preventDefault();
  //   if (!state.amIHost) return;

  //   const videoId = extractYouTubeId(elements.videoUrl.value);
  //   if (!videoId) {
  //     elements.videoHelper.textContent = 'Lien YouTube invalide. Essayez une URL youtube.com/watch, youtu.be ou Shorts.';
  //     return;
  //   }

  //   if (!state.playerReady) {
  //     elements.videoHelper.textContent = 'Le lecteur YouTube charge encore. Reessayez dans un instant.';
  //     return;
  //   }

  //   // Essayer d'abord le flux direct (contourne les restrictions d'intégration)
  //   const directLoaded = await loadDirectStream(videoId);

  //   if (directLoaded) {
  //     elements.videoHelper.textContent = 'Video chargee en flux direct pour toute la room.';
  //     state.socket.emit('player-action', { room: state.room, action: 'load', data: { videoId } });
  //   } else {
  //     // Fallback sur le lecteur YouTube
  //     state.useDirectStream = false;
  //     document.getElementById('player').style.display = 'block';
  //     if (state.directPlayerContainer) state.directPlayerContainer.style.display = 'none';
  //     state.player.loadVideoById(videoId);
  //     state.socket.emit('player-action', { room: state.room, action: 'load', data: { videoId } });
  //     elements.videoHelper.textContent = 'Video chargee pour toute la room (lecteur YouTube).';
  //   }
  // });

  elements.videoForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.amIHost) return;

  const videoId = extractYouTubeId(elements.videoUrl.value);
  if (!videoId) { /* message erreur */ return; }

  // Tenter le flux direct
  const directLoaded = await loadDirectStream(videoId, /* syncOnly = true */ false);
  const playerType = directLoaded ? 'direct' : 'youtube';

  // Informer les autres du chargement avec le type de lecteur
  state.socket.emit('player-action', {
    room: state.room,
    action: 'load',
    data: { videoId, playerType }
  });

  if (!directLoaded) {
    // Fallback YouTube (déjà fait par loadDirectStream ? non, loadDirectStream ne fait rien si échec)
    // Rebasculer sur YouTube
    state.currentPlayerType = 'youtube';
    switchPlayerTypeUI('youtube');
    if (state.player && state.playerReady) {
      state.player.loadVideoById(videoId);
    }
  }
  elements.videoHelper.textContent = directLoaded ? 'Video en flux direct' : 'Video en mode YouTube (intégration standard)';
});
  
  // Détection de seek (host uniquement)
  window.setInterval(() => {
    if (!state.amIHost || !state.hostStatusReceived || state.isRemoteAction) return;

    if (state.useDirectStream && state.directPlayer) {
      const ct = state.directPlayer.currentTime;
      if (state.lastKnownTime !== undefined && Math.abs(ct - state.lastKnownTime) > 1.5) {
        state.socket.emit('player-action', { room: state.room, action: 'seek', data: { currentTime: ct } });
      }
      state.lastKnownTime = ct;
    } else if (state.playerReady && state.player) {
      const currentTime = state.player.getCurrentTime();
      if (state.lastKnownTime !== undefined && Math.abs(currentTime - state.lastKnownTime) > 1.5) {
        state.socket.emit('player-action', { room: state.room, action: 'seek', data: { currentTime } });
      }
      state.lastKnownTime = currentTime;
    }
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

function addMessage({ text, gifUrl, sender, isMe }) {
  const message = document.createElement('div');
  message.className = `message${isMe ? ' is-me' : ''}`;

  const meta = document.createElement('span');
  meta.className = 'message-meta';
  meta.textContent = isMe ? 'Vous' : sender?.displayName || 'Invite';
  message.appendChild(meta);

  if (gifUrl) {
    const img = document.createElement('img');
    img.className = 'chat-gif';
    img.src = gifUrl;
    img.alt = 'GIF';
    message.appendChild(img);
  } else {
    const body = document.createElement('span');
    body.textContent = text;
    message.appendChild(body);
  }

  elements.messages.appendChild(message);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

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

function wireGifPicker() {
  elements.gifBtn.addEventListener('click', () => {
    elements.gifPickerContainer.classList.toggle('hidden');
    elements.emojiPickerContainer.classList.add('hidden');
    if (!elements.gifPickerContainer.classList.contains('hidden')) loadTrendingGifs();
  });
}

async function loadTrendingGifs() {
  if (GIPHY_API_KEY === 'VOTRE_CLE_GIPHY') {
    elements.gifPickerContainer.textContent = 'Ajoutez une cle Giphy dans public/client.js pour activer les GIFs.';
    return;
  }

  elements.gifPickerContainer.textContent = 'Chargement...';
  try {
    const response = await fetch(`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=${GIF_LIMIT}&rating=g`);
    const json = await response.json();
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
  button.className = 'secondary-btn';
  button.type = 'submit';
  button.textContent = 'OK';
  search.append(input, button);
  search.addEventListener('submit', (event) => {
    event.preventDefault();
    searchGifs(input.value);
  });

  const grid = document.createElement('div');
  grid.className = 'gif-grid';
  gifs.forEach((gif) => {
    const image = document.createElement('img');
    image.className = 'gif-thumb';
    image.src = gif.images.fixed_height_small.url;
    image.alt = gif.title || 'GIF';
    image.addEventListener('click', () => {
      const gifUrl = gif.images.original.url;
      state.socket.emit('gif-message', { room: state.room, gifUrl });
      elements.gifPickerContainer.classList.add('hidden');
    });
    grid.appendChild(image);
  });

  elements.gifPickerContainer.append(search, grid);
}

async function searchGifs(query) {
  if (!query.trim()) return;

  elements.gifPickerContainer.textContent = 'Recherche...';
  try {
    const response = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=${GIF_LIMIT}&rating=g`);
    const json = await response.json();
    displayGifs(json.data || []);
  } catch {
    elements.gifPickerContainer.textContent = 'Recherche impossible.';
  }
}

function wireCallControls() {
  elements.startCallBtn.addEventListener('click', async () => {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      elements.startCallBtn.disabled = true;
      elements.callStatus.textContent = 'Appel en cours...';
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
    config: {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    }
  });

  state.peer.on('signal', (data) => {
    if (data.type === 'offer') state.socket.emit('offer', { room: state.room, offer: data });
    else if (data.type === 'answer') state.socket.emit('answer', { room: state.room, answer: data });
    else if (data.candidate) state.socket.emit('ice-candidate', { room: state.room, candidate: data });
  });

  state.peer.on('stream', (remoteStream) => {
    const audio = new Audio();
    audio.srcObject = remoteStream;
    audio.play().catch(console.error);
    elements.hangupBtn.disabled = false;
    elements.callStatus.textContent = 'Audio connecte';
  });

  state.peer.on('error', console.error);
  state.peer.on('close', endCall);
}

async function handleOffer(offer) {
  if (state.peer) return;

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    elements.startCallBtn.disabled = true;
    elements.callStatus.textContent = 'Appel entrant...';
    createPeer(false);
    state.peer.signal(offer);
  } catch (error) {
    elements.callStatus.textContent = 'Micro indisponible';
    console.error(error);
  }
}

function endCall() {
  if (state.peer && !state.peer.destroyed) state.peer.destroy();
  if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
  state.peer = null;
  state.localStream = null;
  elements.startCallBtn.disabled = false;
  elements.hangupBtn.disabled = true;
  elements.callStatus.textContent = 'Audio inactif';
}

// async function loadDirectStream(videoId) {
//   try {
//     console.log('🔄 Récupération du flux direct pour :', videoId);
//     const response = await fetch(`/api/stream?id=${videoId}`);
//     const data = await response.json();

//     if (data.error) {
//       console.warn('Flux direct indisponible :', data.error);
//       return false;
//     }

//     // Masquer le lecteur YouTube, afficher le lecteur direct
//     document.getElementById('player').style.display = 'none';
//     if (state.directPlayerContainer) state.directPlayerContainer.style.display = 'block';

//     state.directPlayer.src = data.streamUrl;
//     state.directPlayer.load();

//     // Synchroniser les événements du lecteur direct avec la room
//     state.directPlayer.onplay = () => {
//       if (!state.amIHost || state.isRemoteAction) return;
//       state.socket.emit('player-action', { room: state.room, action: 'play', data: { currentTime: state.directPlayer.currentTime } });
//     };
//     state.directPlayer.onpause = () => {
//       if (!state.amIHost || state.isRemoteAction) return;
//       state.socket.emit('player-action', { room: state.room, action: 'pause', data: { currentTime: state.directPlayer.currentTime } });
//     };
//     state.directPlayer.onseeked = () => {
//       if (!state.amIHost || state.isRemoteAction) return;
//       state.socket.emit('player-action', { room: state.room, action: 'seek', data: { currentTime: state.directPlayer.currentTime } });
//     };

//     state.useDirectStream = true;
//     state.lastPlayerType = 'direct';
//     return true;
//   } catch (err) {
//     console.error('Erreur flux direct :', err);
//     return false;
//   }
// }

async function loadDirectStream(videoId, isSync = false) {
  try {
    const response = await fetch(`/api/stream?id=${videoId}`);
    const data = await response.json();
    if (data.error) return false;

    // Récupérer les éléments DOM
    const youtubePlayerDiv = document.getElementById('player');
    const directContainer = document.getElementById('direct-player-container');
    youtubePlayerDiv.style.display = 'none';
    directContainer.style.display = 'block';

    if (!state.directPlayer) {
      state.directPlayer = document.getElementById('direct-player');
    }

    // ⚠️ NE PAS assigner .src directement – laisser hls.js le faire
    // Supprimez toute ligne state.directPlayer.src = ...

    // Détruire l'ancienne instance HLS si elle existe
    if (window.hlsInstance) {
      window.hlsInstance.destroy();
      window.hlsInstance = null;
    }

    const streamUrl = data.streamUrl;

    // Vérifier que hls.js est bien chargé
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(streamUrl);
      hls.attachMedia(state.directPlayer);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('✅ Flux HLS chargé et prêt');
        // Optionnel : lancer la lecture si vous voulez l'autoplay
        // state.directPlayer.play().catch(e => console.log("Autoplay bloqué"));
      });
      
      hls.on(Hls.Events.ERROR, (event, errData) => {
        console.error('❌ Erreur HLS.js:', errData);
        if (errData.fatal) {
          hls.destroy();
          window.hlsInstance = null;
        }
      });
      
      window.hlsInstance = hls;
    } 
    // Fallback pour Safari (support natif du HLS)
    else if (state.directPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      state.directPlayer.src = streamUrl;
      state.directPlayer.addEventListener('loadedmetadata', () => {
        console.log('✅ Flux HLS chargé nativement (Safari)');
      });
    } 
    else {
      console.error('❌ Le navigateur ne supporte pas la lecture HLS');
      return false;
    }

    // Nettoyer les anciens gestionnaires d'événements pour éviter les doublons
    state.directPlayer.onplay = null;
    state.directPlayer.onpause = null;
    state.directPlayer.onseeked = null;

    if (state.amIHost) {
      state.directPlayer.onplay = () => {
        if (!state.amIHost || state.isRemoteAction) return;
        state.socket.emit('player-action', { room: state.room, action: 'play', data: { currentTime: state.directPlayer.currentTime } });
      };
      state.directPlayer.onpause = () => {
        if (!state.amIHost || state.isRemoteAction) return;
        state.socket.emit('player-action', { room: state.room, action: 'pause', data: { currentTime: state.directPlayer.currentTime } });
      };
      state.directPlayer.onseeked = () => {
        if (!state.amIHost || state.isRemoteAction) return;
        state.socket.emit('player-action', { room: state.room, action: 'seek', data: { currentTime: state.directPlayer.currentTime } });
      };
    }

    state.currentPlayerType = 'direct';
    return true;
  } catch (err) {
    console.error('❌ Erreur flux direct:', err);
    return false;
  }
}

bootstrapProfileForm();
wireControls();