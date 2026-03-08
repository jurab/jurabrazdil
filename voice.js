// Voice call integration — stripped-down voidchat client
const SIGNALING_URL = 'wss://voice-roulette-signaling.brazdil94.workers.dev/ws';
const CREDENTIALS_URL = 'https://voice-roulette-signaling.brazdil94.workers.dev/turn-credentials';
const AUDIO_BITRATE = 24;

// State
let ws = null;
let pc = null;
let localStream = null;
let remoteAudio = null;
let iceServers = [];
let isHost = false;
let joined = false;
let hostStatus = 'away';

// DOM
const pill = document.getElementById('voice-pill');
const pillLabel = document.getElementById('voice-pill-label');
const authInput = document.getElementById('voice-auth');
const authMsg = document.getElementById('voice-auth-msg');

function requestNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function notify(msg) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(msg, { icon: 'materials/photo.png', silent: false });
  }
}

function setPill(text, status) {
  var translated = (typeof voiceStrings !== 'undefined' && typeof currentLang !== 'undefined' && voiceStrings[currentLang])
    ? (voiceStrings[currentLang][text] || text)
    : text;
  pillLabel.textContent = translated;
  pill.className = 'voice-pill';
  if (status) pill.classList.add(status);
}

// --- Signaling ---

function connect() {
  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    if (joined) ws.send(JSON.stringify({ type: 'join' }));
  };

  ws.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); }
    catch (err) { console.error('voice: parse error', err); }
  };

  ws.onclose = () => {
    setTimeout(connect, 2000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// --- Message handler ---

function onMessage(data) {
  switch (data.type) {
    case 'stats':
      handleStats(data);
      break;

    case 'auth_ok':
      isHost = true;
      authInput.classList.add('hidden');
      authMsg.classList.remove('hidden');
      requestNotifications();
      startCall();
      break;

    case 'waiting':
      if (isHost) {
        setPill('online', 'online');
      } else {
        setPill('connecting...', 'online');
      }
      break;

    case 'matched':
      setPill('connecting...', 'online');
      createPC();
      if (data.initiator) createOffer();
      break;

    case 'offer':
      handleOffer(data.sdp);
      break;

    case 'answer':
      handleAnswer(data.sdp);
      break;

    case 'ice':
      handleIce(data.candidate);
      break;

    case 'partner_left':
      cleanup();
      if (isHost) {
        setPill('online', 'online');
        send({ type: 'join' });
      } else {
        joined = false;
        setPill('call ended', 'online');
        setTimeout(() => {
          if (!joined) setPill('talk to jura', 'online');
        }, 2000);
      }
      break;

    case 'error':
      console.error('voice: server error', data.message);
      break;
  }
}

// --- Stats / status ---

function handleStats(data) {
  hostStatus = data.hostStatus || 'away';

  if (isHost) return;

  if (joined) return; // don't overwrite in-call state

  if (hostStatus === 'online') {
    setPill('talk to jura', 'online');
    pill.style.cursor = 'pointer';
  } else if (hostStatus === 'busy') {
    setPill('in a call', 'busy');
    pill.style.cursor = 'default';
  } else {
    setPill('offline');
    pill.style.cursor = 'default';
  }
}

// --- Auth (host) ---

authInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const token = authInput.value.trim();
  if (token) send({ type: 'auth', token });
  authInput.value = '';
});

// --- Call flow ---

async function startCall() {
  if (localStream || joined) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    joined = true;
    send({ type: 'join' });
    fetchTurn();

    if (!isHost) {
      setPill('connecting...', 'online');
    }
  } catch (err) {
    console.error('voice: mic failed', err);
    setPill('mic denied');
    setTimeout(() => {
      if (hostStatus === 'online') setPill('talk to jura', 'online');
      else setPill('offline');
    }, 2000);
  }
}

function endCall() {
  cleanup();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  joined = false;
  send({ type: 'leave' });

  if (hostStatus === 'online') {
    setPill('talk to jura', 'online');
  } else {
    setPill('offline');
  }
}

async function fetchTurn() {
  try {
    const res = await fetch(CREDENTIALS_URL);
    if (res.ok) {
      const data = await res.json();
      iceServers = data.iceServers;
    }
  } catch (err) {
    console.error('voice: TURN fetch failed', err);
  }
}

// --- WebRTC ---

function createPC() {
  pc = new RTCPeerConnection({ iceServers });

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    remoteAudio = new Audio();
    remoteAudio.srcObject = e.streams[0];
    remoteAudio.play().catch(() => {});
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', candidate: e.candidate.toJSON() });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setPill('talking...', 'online');
      notify(isHost ? 'Someone joined your voice channel' : 'Connected to Jura');
    } else if (pc.connectionState === 'failed') {
      cleanup();
      setPill('failed');
      setTimeout(() => {
        if (hostStatus === 'online') setPill('talk to jura', 'online');
        else setPill('offline');
      }, 2000);
    }
  };
}

function capBitrate(sdp) {
  return sdp.replace(/m=audio.*\r\n/g, m => m + 'b=AS:' + AUDIO_BITRATE + '\r\n');
}

async function createOffer() {
  const offer = await pc.createOffer();
  offer.sdp = capBitrate(offer.sdp);
  await pc.setLocalDescription(offer);
  send({ type: 'offer', sdp: pc.localDescription.toJSON() });
}

async function handleOffer(sdp) {
  if (!pc) createPC();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  answer.sdp = capBitrate(answer.sdp);
  await pc.setLocalDescription(answer);
  send({ type: 'answer', sdp: pc.localDescription.toJSON() });
}

async function handleAnswer(sdp) {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleIce(candidate) {
  if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
}

function cleanup() {
  if (remoteAudio) {
    remoteAudio.srcObject = null;
    remoteAudio = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
}

// --- Pill click ---

pill.addEventListener('click', () => {
  if (isHost) return;
  if (hostStatus !== 'online' && !joined) return;

  requestNotifications();
  if (joined) {
    endCall();
  } else {
    startCall();
  }
});

// --- Cleanup on leave ---

window.addEventListener('beforeunload', () => {
  send({ type: 'leave' });
  if (ws) ws.close();
  cleanup();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

// --- Init ---

connect();
