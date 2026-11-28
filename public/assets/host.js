import {
  fmtClock,
  remainingFrom,
  setServerNow,
  toast,
  connectWS,
} from './common.js';

const $ = (id) => document.getElementById(id);

let ws = null;
let key = '';
let stream = null;
const peers = new Map();
const inputChannels = new Map();
const voiceSenders = new Map();
const remoteVoiceTracks = new Map();
const remoteVoiceAudio = new Map();
let session = null;
const viewerSlots = new Set();
let readySent = false;
let bitrateKbps = 6000;
let fps = 60;
let captureMode = 'card';
let iceServers = [];
let audioCtx = null;
let analyser = null;
let meterRaf = 0;
let statsTimer = null;
let lastStats = null;
let voiceOutputEnabled = true;

// Comandos por P2P: player ──DataChannel──> este host ──ws://127.0.0.1──> ponte.
const params = new URLSearchParams(location.search);
const LOCAL_PORT = Number(params.get('bridgePort') || localStorage.getItem('pl_bridge_port') || 8765);
let local = null;
let localReady = false;
let localTimer = null;
const lastInputSeq = new Map();
const inputStats = { p2p: 0, dropped: 0 };

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

boot();

function boot() {
  restorePrefs();
  bindUI();
  applyCaptureMode();

  const saved = localStorage.getItem('xp_host_key') || '';
  if (saved) {
    $('hostKeyInput').value = saved;
    connect(saved);
  }

  setInterval(updateClock, 500);
}

function restorePrefs() {
  const prefs = JSON.parse(localStorage.getItem('xp_host_prefs') || '{}');
  if (prefs.autoStart === false) $('autoStart').checked = false;
  if (prefs.keepCapture === true) $('keepCapture').checked = true;
  if (prefs.captureMode === 'window' || prefs.captureMode === 'card') captureMode = prefs.captureMode;
  if (prefs.resolution) $('resSelect').value = prefs.resolution;
  if (prefs.fps) $('fpsSelect').value = prefs.fps;
  if (prefs.bitrate) $('bitrateSelect').value = prefs.bitrate;
  bitrateKbps = Number($('bitrateSelect').value);
  fps = Number($('fpsSelect').value);
  $('videoSelect').dataset.saved = prefs.videoId || '';
  $('audioSelect').dataset.saved = prefs.audioId || '';
}

function savePrefs() {
  localStorage.setItem('xp_host_prefs', JSON.stringify({
    autoStart: $('autoStart').checked,
    keepCapture: $('keepCapture').checked,
    captureMode,
    resolution: $('resSelect').value,
    fps: $('fpsSelect').value,
    bitrate: $('bitrateSelect').value,
    videoId: $('videoSelect').value || '',
    audioId: $('audioSelect').value || '',
  }));
}

function applyCaptureMode() {
  const windowMode = captureMode === 'window';
  for (const btn of document.querySelectorAll('#sourceMode [data-mode]')) {
    btn.classList.toggle('active', btn.dataset.mode === captureMode);
  }
  $('cardFields').classList.toggle('hidden', windowMode);
  $('windowFields').classList.toggle('hidden', !windowMode);
  $('btnDetect').classList.toggle('hidden', windowMode);
  $('btnWindow').classList.toggle('hidden', windowMode);
  $('btnStart').textContent = windowMode ? 'Escolher janela do jogo' : 'Iniciar captura da placa';
  $('sourceHint').textContent = windowMode
    ? 'O jogo roda no próprio PC (Steam, emulador ou qualquer app).'
    : 'O jogo roda em um console ligado à placa de captura HDMI.';
}

/* ------------------------------------------------------------------ */
/* Conexão                                                            */
/* ------------------------------------------------------------------ */

function connect(hostKey) {
  key = hostKey.trim();
  if (!key) return toast('Informe a chave do host.', 'warn');
  localStorage.setItem('xp_host_key', key);

  ws?.close();
  setBadge('connecting', 'conectando');

  ws = connectWS({
    role: 'host',
    key,
    onStatus(status) {
      if (status === 'online') setBadge('live', 'conectado');
      else if (status === 'connecting') setBadge('reserved', 'conectando');
      else if (status === 'replaced') {
        setBadge('off', 'aberto em outro lugar');
        toast('Este host foi conectado em outra aba. Feche uma delas.', 'warn', 8000);
      } else setBadge('off', 'reconectando');
    },
    onOpen(msg) {
      $('authCard').classList.add('hidden');
      $('main').classList.remove('hidden');
      if (msg.iceServers?.length) iceServers = msg.iceServers;
      if (msg.state?.serverNow) setServerNow(msg.state.serverNow);
      applySession(msg.session);
      log('Conectado ao servidor como host.');
      connectLocal();
      loadDevices(false);
      updateUI();
    },
    onClose(event) {
      if (event?.code === 4001) log('Outra aba assumiu o papel de host.', 'warn');
      else log('Conexão com o servidor caiu. Tentando reconectar…', 'warn');
    },
    onMessage: handleMessage,
  });
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'host:state':
      if (msg.state?.serverNow) setServerNow(msg.state.serverNow);
      applySession(msg.session);
      break;

    case 'session:created':
    case 'session:started':
    case 'session:extended': {
      const previousStatus = session?.status;
      applySession(msg.session);
      log(`Sessão ${msg.type.split(':')[1]}${msg.session?.id ? ` (${msg.session.id.slice(-6)})` : ''}.`, 'info');
      if (msg.type === 'session:extended') toast('O dono adicionou tempo.', 'green');
      if (['provisioning', 'active'].includes(session?.status)) {
        if ($('autoStart').checked && !stream && captureMode === 'card') {
          log('Sessão paga: iniciando captura automática…');
          await startCapture();
        } else if (captureMode === 'window' && !stream) {
          log('Modo janela: clique em “Escolher janela do jogo” para publicar.', 'warn');
        } else if (stream && !readySent) {
          sendReady();
        }
      }
      if (previousStatus === 'provisioning' && session?.status === 'active') {
        log('Relógio do jogador iniciado.');
      }
      break;
    }

    case 'session:warning':
      log(`Aviso enviado ao jogador: faltam ${msg.minutes} min.`);
      break;

    case 'session:ended':
      log('Sessão encerrada.', 'warn');
      applySession({ ...session, status: 'ended', endsAt: session?.endsAt ?? null });
      if ($('keepCapture').checked && stream) {
        closePeers();
        readySent = false;
        viewerSlots.clear();
        updateUI();
        log('Captura mantida ativa, aguardando o próximo jogador.');
      } else {
        log('Parando captura.');
        teardown();
      }
      break;

    case 'viewer:joined':
      {
        const slot = Number(msg.playerSlot ?? 1);
        viewerSlots.add(slot);
        log(`Player ${slot} conectado.`);
        updateUI();
        if (stream) await publish(slot);
      }
      break;

    case 'viewer:left':
      {
        const slot = Number(msg.playerSlot ?? 1);
        viewerSlots.delete(slot);
        log(`Player ${slot} desconectou (o tempo continua correndo).`, 'warn');
        closePeer(slot);
        updateUI();
      }
      break;

    case 'answer':
      try {
        await peers.get(Number(msg.playerSlot ?? 1))?.setRemoteDescription(msg.payload);
        log(`Negociação WebRTC concluída para o player ${Number(msg.playerSlot ?? 1)}.`);
      } catch (err) {
        log(`Falha no answer: ${err.message}`, 'error');
      }
      break;

    case 'candidate':
      try {
        await peers.get(Number(msg.playerSlot ?? 1))?.addIceCandidate(msg.payload);
      } catch {
        /* candidato atrasado */
      }
      break;

    case 'request-offer': {
      const slot = Number(msg.playerSlot ?? 1);
      if (stream) await publish(slot);
      break;
    }

    case 'input:ack':
      break;

    case 'error':
      if (msg.code === 'invalid_host_key') {
        toast('Chave do host inválida.', 'danger');
        $('main').classList.add('hidden');
        $('authCard').classList.remove('hidden');
        localStorage.removeItem('xp_host_key');
      } else {
        log(`Erro: ${msg.message}`, 'error');
      }
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Comandos por P2P (DataChannel) → ponte local                       */
/* ------------------------------------------------------------------ */

function setLocalBadge(ready) {
  $('localDot').className = `dot ${ready ? 'live' : 'off'}`;
  $('localText').textContent = ready ? 'ponte local: online' : 'ponte local: offline';
}

function sendLocal(message) {
  if (local?.readyState === WebSocket.OPEN) local.send(JSON.stringify(message));
}

function sendInputChannel(slot, message) {
  const channel = inputChannels.get(slot);
  if (channel?.readyState === 'open') {
    try {
      channel.send(JSON.stringify(message));
    } catch {
      /* canal fechando */
    }
  }
}

/** Diz ao player se os comandos P2P têm para onde ir (ponte local conectada). */
function announceRoute(slot) {
  sendInputChannel(slot, { k: 'route', ok: localReady });
}

function connectLocal() {
  clearTimeout(localTimer);
  if (!key) return;
  if (local && local.readyState <= WebSocket.OPEN) return;

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${LOCAL_PORT}/local`);
  } catch {
    localTimer = setTimeout(connectLocal, 5000);
    return;
  }
  local = socket;

  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', key }));
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'hello' && msg.ok) {
      localReady = true;
      setLocalBadge(true);
      log('Ponte de controle local conectada: comandos por P2P liberados.');
      for (const slot of inputChannels.keys()) announceRoute(slot);
    } else if (msg.type === 'pong') {
      sendInputChannel(Number(msg.playerSlot ?? 1), { k: 'pong', id: msg.id });
    }
  };
  const down = () => {
    if (local !== socket) return;
    const was = localReady;
    localReady = false;
    local = null;
    setLocalBadge(false);
    if (was) {
      log('Ponte de controle local desconectada. Comandos voltam pelo WebSocket.', 'warn');
      for (const slot of inputChannels.keys()) announceRoute(slot);
    }
    localTimer = setTimeout(connectLocal, 3000);
  };
  socket.onclose = down;
  socket.onerror = () => {};
}

function onInputChannelMessage(raw, slot) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.k === 'i') {
    // Canal não ordenado: descarta pacotes mais velhos que o último aplicado.
    if (!Number.isFinite(msg.s) || msg.s <= (lastInputSeq.get(slot) ?? -1)) return;
    lastInputSeq.set(slot, msg.s);
    if (!localReady) {
      inputStats.dropped++;
      return;
    }
    inputStats.p2p++;
    sendLocal({ type: 'input', payload: { ...msg.p, playerSlot: slot } });
  } else if (msg.k === 'ping') {
    if (localReady) sendLocal({ type: 'ping', id: msg.id, playerSlot: slot });
    else announceRoute(slot);
  }
}

function setBadge(kind, text) {
  $('connDot').className = `dot ${kind}`;
  $('connText').textContent = text;
}

/* ------------------------------------------------------------------ */
/* Sessão                                                             */
/* ------------------------------------------------------------------ */

function applySession(next) {
  if (next === null || next === undefined) {
    if (session && ['provisioning', 'active'].includes(session.status)) return;
    session = null;
  } else {
    session = { ...(session ?? {}), ...next };
  }
  updateUI();
}

function updateUI() {
  const status = session?.status;
  const badge = $('sessionBadge');
  const badgeText = $('sessionBadgeText');

  if (!status || status === 'ended' || status === 'forfeited') {
    badgeText.textContent = status ? 'encerrada' : 'sem sessão';
    badge.className = 'badge';
    $('sessionState').textContent = status ? 'encerrada' : '—';
    $('sessionCustomer').textContent = '—';
    $('sessionHours').textContent = '—';
  } else {
    badgeText.textContent = status === 'active' ? 'ativa' : 'provisionando';
    badge.className = `badge ${status === 'active' ? 'green' : 'purple'}`;
    $('sessionState').textContent = status === 'active' ? 'jogando' : 'preparando';
    $('sessionCustomer').textContent = session.customerFirstName ?? '—';
    $('sessionHours').textContent = session.minutes ? `${session.minutes} min` : '—';
  }

  $('viewerState').textContent = viewerSlots.size ? `${viewerSlots.size} conectado(s)` : 'não';
  $('publishState').textContent = [...peers.values()].some((peer) => peer.connectionState === 'connected')
    ? 'sim'
    : 'não';

  $('btnStart').disabled = Boolean(stream);
  $('btnStop').disabled = !stream;
  $('btnPublish').disabled = !stream || !['active', 'provisioning'].includes(status);

  if (stream) {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    $('previewBadge').textContent = settings.width
      ? `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate ?? 0)}`
      : 'sinal ativo';
  } else {
    $('previewBadge').textContent = 'sem sinal';
  }

  updateClock();
}

function updateClock() {
  const clock = $('sessionClock');
  if (!session?.endsAt) {
    clock.textContent = '—';
    clock.classList.remove('warn', 'danger');
    return;
  }
  if (session.status !== 'active') {
    clock.textContent = '—';
    return;
  }
  const left = remainingFrom(session.endsAt);
  clock.textContent = fmtClock(left);
  clock.classList.toggle('warn', left <= 5 * 60_000 && left > 60_000);
  clock.classList.toggle('danger', left <= 60_000);
}

/* ------------------------------------------------------------------ */
/* Captura                                                            */
/* ------------------------------------------------------------------ */

async function loadDevices(requestPermission) {
  try {
    if (requestPermission) {
      const temp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      temp.getTracks().forEach((t) => t.stop());
      log('Permissão de câmera/microfone concedida (usada só para listar a placa).');
    }
  } catch (err) {
    log(`Permissão negada ou indisponível: ${err.message}`, 'warn');
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videos = devices.filter((d) => d.kind === 'videoinput');
  const audios = devices.filter((d) => d.kind === 'audioinput');

  fillSelect($('videoSelect'), videos, 'Nenhuma placa encontrada');
  fillSelect($('audioSelect'), audios, 'Sem áudio (vídeo mudo)');

  $('deviceCount').textContent = `${videos.length} vídeo · ${audios.length} áudio`;
  log(`Dispositivos: ${videos.length} entrada(s) de vídeo, ${audios.length} de áudio.`);

  if (videos.length) {
    const saved = $('videoSelect').dataset.saved;
    const match = videos.find((d) => d.deviceId === saved)
      ?? videos.find((d) => /capture|elgato|avermedia|hdmi|usb video|game/i.test(d.label))
      ?? videos[0];
    if (match) $('videoSelect').value = match.deviceId;
  }
  if (audios.length) {
    const saved = $('audioSelect').dataset.saved;
    const match = audios.find((d) => d.deviceId === saved)
      ?? audios.find((d) => /capture|elgato|avermedia|hdmi|usb|line/i.test(d.label))
      ?? audios[0];
    if (match) $('audioSelect').value = match.deviceId;
  }

  savePrefs();
  return { videos, audios };
}

function fillSelect(select, devices, emptyLabel) {
  const current = select.value;
  select.innerHTML = '';

  if (!devices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.appendChild(option);
    return;
  }

  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Dispositivo ${device.deviceId.slice(0, 6)}`;
    select.appendChild(option);
  }
  if (current && devices.some((d) => d.deviceId === current)) select.value = current;
}

async function startCapture() {
  if (stream) return stream;

  const videoId = $('videoSelect').value;
  const audioId = $('audioSelect').value;
  const [width, height] = $('resSelect').value.split('x').map(Number);
  fps = Number($('fpsSelect').value);
  bitrateKbps = Number($('bitrateSelect').value);

  const constraints = {
    video: {
      ...(videoId ? { deviceId: { exact: videoId } } : {}),
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: fps, max: fps },
    },
    audio: audioId
      ? {
          deviceId: { exact: audioId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
        }
      : false,
  };

  try {
    log('Abrindo a placa de captura…');
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    log(`Falha ao abrir a captura: ${err.message}`, 'error');
    toast('Não foi possível abrir a placa de captura. Veja o log.', 'danger', 7000);
    stream = null;
    return null;
  }

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  const settings = videoTrack?.getSettings?.() ?? {};

  if (videoTrack) videoTrack.contentHint = 'motion';
  if (audioTrack) audioTrack.contentHint = 'music';

  $('preview').srcObject = stream;
  $('preview').play().catch(() => {});

  log(
    `Captura ativa: ${settings.width ?? '?'}×${settings.height ?? '?'} `
    + `@ ${Math.round(settings.frameRate ?? 0)}fps — ${videoTrack?.label ?? 'vídeo'}`,
  );
  if (audioTrack) {
    const a = audioTrack.getSettings?.() ?? {};
    log(`Áudio: ${audioTrack.label} (${a.sampleRate ?? '?'} Hz, ${a.channelCount ?? '?'} canais).`);
  } else {
    log('Sem áudio capturado: o jogador ouvirá silêncio.', 'warn');
  }

  setupMeter(stream);
  updateUI();

  if (['provisioning', 'active'].includes(session?.status)) sendReady();
  for (const slot of viewerSlots) await publish(slot);

  return stream;
}

async function startWindowCapture() {
  if (stream) return toast('Pare a captura atual primeiro.', 'warn');
  if (!navigator.mediaDevices?.getDisplayMedia) {
    log('Este navegador não suporta captura de janela. Use Chrome ou Edge atualizado.', 'error');
    return toast('Captura de janela indisponível neste navegador.', 'danger', 7000);
  }
  try {
    log('Abrindo seletor de janela (jogo/emulador)…');
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: true,
    });
    stream = display;
    $('preview').srcObject = display;
    $('preview').play().catch(() => {});
    setupMeter(display);
    log('Captura de janela ativa. Mantenha a janela do jogo visível.');
    updateUI();
    if (['provisioning', 'active'].includes(session?.status)) sendReady();
    for (const slot of viewerSlots) await publish(slot);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      log('Captura de janela cancelada pelo operador.', 'warn');
    } else {
      log(`Falha na captura de janela: ${err.message}`, 'error');
    }
  }
}

function sendReady() {
  if (!ws?.ready || !stream || !session) return;
  if (readySent) return;
  const sent = ws.send({ type: 'stream:ready' });
  if (sent) {
    readySent = true;
    log('Transmissão publicada: o relógio do jogador começou a contar.');
    toast('Transmissão no ar. Relógio iniciado.', 'green', 5000);
  }
}

async function publish(slot = 1) {
  if (!stream || !ws?.ready) return;

  closePeer(slot);
  log(`Negociando vídeo com o player ${slot}…`);
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(slot, pc);
  const gameAudioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const voiceTransceiver = pc.addTransceiver('audio', { direction: 'sendonly' });
  voiceSenders.set(slot, voiceTransceiver.sender);
  syncForwardedVoice(slot);

  // Canal de comandos: não ordenado e sem reenvio (comportamento de UDP).
  // Um estado antigo de botão não vale a pena ser reenviado.
  const inputDC = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  inputChannels.set(slot, inputDC);
  inputDC.onopen = () => {
    lastInputSeq.set(slot, -1);
    log(`Canal de comandos P2P do player ${slot} aberto.`);
    announceRoute(slot);
  };
  inputDC.onclose = () => {
    log(`Canal de comandos P2P do player ${slot} fechado.`, 'warn');
    sendLocal({ type: 'release', playerSlot: slot });
  };
  inputDC.onmessage = (event) => onInputChannelMessage(event.data, slot);

  pc.onicecandidate = (event) => {
    if (event.candidate) ws?.send({ type: 'candidate', payload: event.candidate, playerSlot: slot });
  };

  pc.onconnectionstatechange = () => {
    if (peers.get(slot) !== pc) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      log(`Player ${slot} recebendo vídeo (P2P conectado).`);
      startStats(pc);
    } else if (state === 'failed') {
      log(`Conexão P2P do player ${slot} falhou. O player vai pedir nova negociação.`, 'error');
    } else if (state === 'disconnected') {
      log(`Conexão P2P do player ${slot} instável.`, 'warn');
    }
    updateUI();
  };

  pc.ontrack = (event) => {
    if (peers.get(slot) !== pc || event.track.kind !== 'audio') return;
    receiveVoiceTrack(slot, event.track);
  };

  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    try {
      await gameAudioTransceiver.sender.replaceTrack(audioTrack);
    } catch (err) {
      log(`Falha ao adicionar áudio do jogo: ${err.message}`, 'error');
    }
  }
  for (const track of stream.getVideoTracks()) {
    const sender = pc.addTrack(track, stream);
    await tuneSender(sender, true);
  }

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send({ type: 'offer', payload: offer, playerSlot: slot });
  } catch (err) {
    log(`Falha ao criar oferta para o player ${slot}: ${err.message}`, 'error');
    closePeer(slot);
  }
  updateUI();
}

async function tuneSender(sender, isVideo) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    if (isVideo) {
      params.encodings[0].maxBitrate = bitrateKbps * 1000;
      params.encodings[0].maxFramerate = fps;
      params.degradationPreference = 'maintain-framerate';
    }
    await sender.setParameters(params);
  } catch (err) {
    log(`Ajuste de bitrate ignorado: ${err.message}`, 'warn');
  }
}

function closePeer(slot) {
  const channel = inputChannels.get(slot);
  const peer = peers.get(slot);
  clearReceivedVoice(slot);
  inputChannels.delete(slot);
  peers.delete(slot);
  voiceSenders.delete(slot);
  lastInputSeq.delete(slot);
  if (channel) {
    channel.onclose = null;
    sendLocal({ type: 'release', playerSlot: slot });
    try {
      channel.close();
    } catch {
      /* ignore */
    }
  }
  try {
    peer?.close();
  } catch {
    /* ignore */
  }
  if (peers.size === 0) stopStats();
  updateUI();
}

function receiveVoiceTrack(slot, track) {
  clearReceivedVoice(slot);
  remoteVoiceTracks.set(slot, track);

  const audio = new Audio();
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = new MediaStream([track]);
  remoteVoiceAudio.set(slot, audio);
  track.onended = () => clearReceivedVoice(slot);
  syncForwardedVoice();
  updateVoiceStatus();
  playRemoteVoice(slot, audio);
}

function clearReceivedVoice(slot) {
  const track = remoteVoiceTracks.get(slot);
  if (track) track.onended = null;
  remoteVoiceTracks.delete(slot);

  const audio = remoteVoiceAudio.get(slot);
  if (audio) {
    audio.pause();
    audio.srcObject = null;
  }
  remoteVoiceAudio.delete(slot);

  for (const [targetSlot, sender] of voiceSenders) {
    if (targetSlot !== slot && sender.track === track) {
      sender.replaceTrack(null).catch((err) => {
        log(`Falha ao parar o retorno de voz para o player ${targetSlot}: ${err.message}`, 'warn');
      });
    }
  }
  syncForwardedVoice();
  updateVoiceStatus();
}

function syncForwardedVoice(targetSlot = null) {
  for (const [slot, sender] of voiceSenders) {
    if (targetSlot !== null && targetSlot !== slot) continue;
    const sourceTrack = [...remoteVoiceTracks]
      .find(([sourceSlot, track]) => sourceSlot !== slot && track.readyState === 'live')?.[1] ?? null;
    if (sender.track === sourceTrack) continue;
    sender.replaceTrack(sourceTrack).catch((err) => {
      log(`Falha ao encaminhar voz para o player ${slot}: ${err.message}`, 'warn');
    });
  }
}

function updateVoiceStatus() {
  const status = $('voiceStatus');
  if (!status) return;
  status.textContent = remoteVoiceTracks.size
    ? `recebendo voz de ${remoteVoiceTracks.size} player${remoteVoiceTracks.size === 1 ? '' : 's'}`
    : 'aguardando voz';
}

function playRemoteVoice(slot, audio) {
  if (!voiceOutputEnabled) return;
  audio.play().then(() => {
    $('btnVoiceOutput').classList.add('hidden');
  }).catch((err) => {
    voiceOutputEnabled = false;
    $('btnVoiceOutput').classList.remove('hidden');
    log(`Reprodução de voz bloqueada; ative o áudio para o OBS capturar: ${err.message}`, 'warn');
  });
}

function closePeers() {
  for (const slot of [...peers.keys()]) closePeer(slot);
}

function teardown() {
  closePeers();
  stopMeter();
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  $('preview').srcObject = null;
  readySent = false;
  viewerSlots.clear();
  updateUI();
  log('Captura parada.');
}

/* ------------------------------------------------------------------ */
/* Medidor de áudio                                                   */
/* ------------------------------------------------------------------ */

function setupMeter(mediaStream) {
  stopMeter();
  const audioTrack = mediaStream.getAudioTracks()[0];
  const bar = $('meterBar');
  const text = $('meterText');

  if (!audioTrack) {
    text.textContent = 'sem áudio';
    bar.style.width = '0%';
    return;
  }

  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    source.connect(analyser);
    analyser.connect(sink);
    sink.connect(audioCtx.destination);

    const buffer = new Uint8Array(analyser.fftSize);

    const loop = () => {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (let i = 0; i < buffer.length; i++) {
        peak = Math.max(peak, Math.abs(buffer[i] - 128));
      }
      const pct = Math.min(100, (peak / 128) * 140);
      bar.style.width = `${pct}%`;
      text.textContent = pct < 1 ? 'silêncio' : pct < 12 ? 'baixo' : pct < 60 ? 'ok' : 'alto';
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch (err) {
    text.textContent = 'erro';
    log(`Medidor de áudio: ${err.message}`, 'warn');
  }
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  meterRaf = 0;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  const bar = $('meterBar');
  if (bar) bar.style.width = '0%';
  const text = $('meterText');
  if (text) text.textContent = '—';
}

/* ------------------------------------------------------------------ */
/* Estatísticas                                                       */
/* ------------------------------------------------------------------ */

function startStats() {
  if (statsTimer) return;
  statsTimer = setInterval(sendStats, 3000);
}

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
  lastStats = null;
}

async function sendStats() {
  const pc = [...peers.values()].find((peer) => peer.connectionState === 'connected');
  if (!pc) return;
  try {
    const report = await pc.getStats();
    let out = null;
    let pair = null;

    report.forEach((entry) => {
      if (entry.type === 'outbound-rtp' && entry.kind === 'video') out = entry;
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded'
        && (entry.nominated || entry.selected)) pair = entry;
    });
    if (!out) return;

    const nowTs = performance.now();
    let bitrate = null;
    if (lastStats && nowTs > lastStats.ts) {
      bitrate = ((out.bytesSent - lastStats.bytes) * 8) / ((nowTs - lastStats.ts) / 1000);
    }
    lastStats = { ts: nowTs, bytes: out.bytesSent };

    ws?.send({
      type: 'stream:stats',
      payload: {
        bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
        fps: out.framesPerSecond ?? null,
        quality: out.qualityLimitationReason ?? null,
        rttMs: pair?.currentRoundTripTime != null
          ? Math.round(pair.currentRoundTripTime * 1000)
          : null,
        width: out.frameWidth ?? null,
        height: out.frameHeight ?? null,
      },
    });

    if (out.qualityLimitationReason && out.qualityLimitationReason !== 'none') {
      log(`Qualidade limitada por: ${out.qualityLimitationReason}`, 'warn');
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Log + UI                                                           */
/* ------------------------------------------------------------------ */

function log(message, level = 'info') {
  const host = $('log');
  if (!host) return;
  const entry = document.createElement('div');
  entry.className = `entry ${level}`;
  const time = new Date().toLocaleTimeString('pt-BR');
  entry.innerHTML = `<time>${time}</time><span class="type">${level}</span><span class="detail"></span>`;
  entry.querySelector('.detail').textContent = message;
  host.prepend(entry);
  while (host.children.length > 120) host.lastChild.remove();
  console.log(`[host] ${message}`);
}

function bindUI() {
  $('btnConnect').addEventListener('click', () => connect($('hostKeyInput').value));
  $('btnVoiceOutput').addEventListener('click', async () => {
    voiceOutputEnabled = true;
    try {
      await Promise.all([...remoteVoiceAudio].map(([, audio]) => audio.play()));
      $('btnVoiceOutput').classList.add('hidden');
      log('Reprodução da voz dos jogadores ativada para a saída de áudio do PC.');
    } catch (err) {
      voiceOutputEnabled = false;
      log(`Não foi possível reproduzir a voz: ${err.message}`, 'error');
      toast('Não foi possível ativar o áudio de voz. Verifique a saída de som do PC.', 'danger');
    }
  });

  $('hostKeyInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') connect($('hostKeyInput').value);
  });

  $('btnDetect').addEventListener('click', async () => {
    $('btnDetect').disabled = true;
    $('btnDetect').textContent = 'Detectando…';
    try {
      await loadDevices(true);
      toast('Dispositivos atualizados.', 'green');
    } catch (err) {
      log(`Não foi possível listar dispositivos: ${err.message}`, 'error');
    } finally {
      $('btnDetect').disabled = false;
      $('btnDetect').textContent = 'Detectar dispositivos';
    }
  });

  $('btnStart').addEventListener('click', () => {
    if (captureMode === 'window') return startWindowCapture();
    return startCapture();
  });
  $('btnWindow').addEventListener('click', startWindowCapture);
  $('sourceMode').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-mode]');
    if (!btn || btn.dataset.mode === captureMode) return;
    if (stream) return toast('Pare a captura antes de trocar a fonte.', 'warn');
    captureMode = btn.dataset.mode;
    savePrefs();
    applyCaptureMode();
  });
  $('btnStop').addEventListener('click', () => {
    if (stream && !confirm('Parar a captura? O jogador vai ficar sem imagem, mas o relógio continua.')) return;
    teardown();
  });
  $('btnPublish').addEventListener('click', async () => {
    if (!stream) return toast('Inicie a captura primeiro.', 'warn');
    if (!['provisioning', 'active'].includes(session?.status)) {
      return toast('Não há sessão ativa para publicar.', 'warn');
    }
    await publish();
  });

  $('btnClearLog').addEventListener('click', () => {
    $('log').innerHTML = '';
  });

  for (const id of ['videoSelect', 'audioSelect', 'resSelect', 'fpsSelect', 'bitrateSelect', 'autoStart', 'keepCapture']) {
    $(id).addEventListener('change', savePrefs);
  }

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    loadDevices(false).catch(() => {});
  });

  window.addEventListener('beforeunload', () => {
    stream?.getTracks().forEach((t) => t.stop());
    for (const peer of peers.values()) peer.close();
  });
}
