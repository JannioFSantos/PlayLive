import { api, fmtClock } from './common.js';
import { resolveLanguage, translate } from './live-i18n.js';

const $ = (id) => document.getElementById(id);
const KEY = 'xp_live_viewer';
const language = resolveLanguage(navigator.languages?.length
  ? navigator.languages
  : [navigator.language]);
const t = (key, values) => translate(language, key, values);
const errorKeys = {
  invalid_nick: 'errorInvalidNick',
  live_disabled: 'errorLiveDisabled',
  not_in_queue: 'chatJoin',
  chat_disabled: 'chatPaused',
  invalid_chat_message: 'chatInvalid',
  lobby_full: 'errorLobbyFull',
  rate_limited: 'errorRateLimited',
  internal: 'errorInternal',
};

let viewerId = null;
let nick = null;
let shownVideo = null;
let playingDeadline = null;
let liveEnabled = false;
let chatEnabled = false;
let chatMember = false;
let chatCursor = 0;
let chatRevision = null;
let chatInFlight = false;

function applyLanguage() {
  document.documentElement.lang = language === 'pt' ? 'pt-BR' : language;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  $('turnTitle').textContent = t('turnTitle', { nick: '' });
  $('nick').placeholder = t('nicknamePlaceholder');
  $('player').title = t('playerTitle');
  $('chatInput').placeholder = t('chatInputPlaceholder');
}

function localizedError(error) {
  const key = errorKeys[error.code];
  if (key) return t(key);
  return error.status ? error.message : t('errorConnection');
}

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  if (saved?.viewerId) ({ viewerId, nick } = saved);
} catch { /* sem storage */ }

function save() {
  try {
    if (viewerId) localStorage.setItem(KEY, JSON.stringify({ viewerId, nick }));
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

function say(text, bad = false) {
  $('msg').textContent = text ?? '';
  $('msg').style.color = bad ? 'var(--danger, #ff5d6c)' : '';
}

function renderQueue(queue) {
  const list = $('queueList');
  const fragment = document.createDocumentFragment();
  for (const name of queue) {
    const item = document.createElement('li');
    item.textContent = name;
    fragment.append(item);
  }
  list.replaceChildren(fragment);
  const empty = queue.length === 0;
  $('queueEmpty').classList.toggle('hidden', !empty);
  list.classList.toggle('hidden', empty);
}

function renderPlaying(playing) {
  if (!playing) {
    playingDeadline = null;
    $('playingCard').classList.add('hidden');
    return;
  }
  $('playingName').textContent = playing.name;
  playingDeadline = Date.now() + playing.remainingMs;
  $('playingCard').classList.remove('hidden');
  updatePlayingClock();
}

function updatePlayingClock() {
  if (playingDeadline === null) return;
  $('playingTime').textContent = fmtClock(Math.max(0, playingDeadline - Date.now()));
}

function clearChatView() {
  $('chatMessages').replaceChildren();
  chatCursor = 0;
  chatRevision = null;
}

function updateChatUI() {
  const canAccess = liveEnabled && chatMember;
  $('chatMessages').classList.toggle('hidden', !canAccess);
  $('chatForm').classList.toggle('hidden', !canAccess);
  $('chatAccess').classList.toggle('hidden', canAccess && chatEnabled);
  $('chatAccess').textContent = canAccess ? t('chatPaused') : t('chatJoin');
  $('chatInput').disabled = !canAccess || !chatEnabled;
  $('chatSend').disabled = !canAccess || !chatEnabled;
  $('chatStatus').textContent = chatEnabled ? t('chatActive') : t('chatPausedBadge');
  $('chatStatus').className = `badge ${chatEnabled ? 'green' : ''}`;
  if (!canAccess) {
    clearChatView();
    $('chatError').textContent = '';
  }
}

function appendChatMessage(message) {
  $('chatMessages').querySelector('.chat-empty')?.remove();
  const item = document.createElement('div');
  item.className = 'chat-message';
  const author = document.createElement('strong');
  author.textContent = message.nick;
  const text = document.createElement('p');
  text.textContent = message.text;
  item.append(author, text);
  $('chatMessages').append(item);
}

async function refreshChat() {
  if (!viewerId || !liveEnabled || !chatMember || chatInFlight) return;
  const requestedViewerId = viewerId;
  chatInFlight = true;
  try {
    const result = await api('/api/live/chat/read', {
      method: 'POST',
      body: { viewerId, after: chatCursor, revision: chatRevision },
    });
    if (requestedViewerId !== viewerId || !chatMember || !liveEnabled) return;
    chatEnabled = result.chatEnabled;
    updateChatUI();
    if (result.reset || result.revision !== chatRevision) {
      $('chatMessages').replaceChildren();
      chatCursor = 0;
      chatRevision = result.revision;
    }
    for (const message of result.messages) {
      appendChatMessage(message);
      chatCursor = message.id;
    }
    if (result.messages.length) {
      $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    } else if (chatCursor === 0 && !$('chatMessages').firstElementChild) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty tiny muted';
      empty.textContent = t('chatEmpty');
      $('chatMessages').append(empty);
    }
    $('chatError').textContent = '';
  } catch (err) {
    if (err.code === 'not_in_queue' || err.code === 'live_disabled') {
      chatMember = false;
      liveEnabled = err.code !== 'live_disabled';
      updateChatUI();
    } else {
      $('chatError').textContent = t(errorKeys[err.code] ?? 'errorConnection');
    }
  } finally {
    chatInFlight = false;
  }
}

function showRoom(joined, name) {
  $('joinForm').classList.toggle('hidden', joined);
  $('inRoom').classList.toggle('hidden', !joined);
  if (joined) $('inRoomNick').textContent = name ?? '';
}

function mountVideo(videoId) {
  if (shownVideo === videoId) return;
  shownVideo = videoId;
  const id = encodeURIComponent(videoId);
  const languageParam = `&hl=${encodeURIComponent(language)}`;
  $('player').src = `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0${languageParam}`;
}

async function refresh() {
  try {
    const info = await api('/api/live');
    liveEnabled = Boolean(info.enabled);
    chatEnabled = Boolean(info.chatEnabled);
    $('offCard').classList.toggle('hidden', info.enabled);
    $('liveGrid').classList.toggle('hidden', !info.enabled);
    renderQueue(Array.isArray(info.queue) ? info.queue : []);
    renderPlaying(info.playing);
    if (info.enabled) {
      mountVideo(info.videoId);
      $('roomBadge').textContent = t('roomCount', {
        count: new Intl.NumberFormat(language).format(info.viewers),
      });
    } else if (shownVideo) {
      shownVideo = null;
      $('player').removeAttribute('src');
    }

    if (viewerId) {
      const me = await api(`/api/live/me?v=${encodeURIComponent(viewerId)}`);
      chatMember = Boolean(me.joined || me.chosen);
      if (me.chosen) {
        $('turnCard').classList.remove('hidden');
        $('turnTitle').textContent = t('turnTitle', { nick: me.nick });
        $('turnBtn').href = me.playUrl;
        $('turnHint').textContent = me.sessionStatus === 'provisioning'
          ? t('turnPreparing')
          : t('turnHint');
        showRoom(true, me.nick);
      } else {
        $('turnCard').classList.add('hidden');
        if (me.joined) {
          showRoom(true, me.nick);
        } else {
          // O servidor não conhece mais esse espectador (reinício ou ficou ausente).
          viewerId = null;
          nick = null;
          chatMember = false;
          save();
          showRoom(false);
        }
      }
    } else {
      chatMember = false;
      $('turnCard').classList.add('hidden');
      showRoom(false);
    }
    updateChatUI();
    await refreshChat();
  } catch (err) {
    say(localizedError(err), true);
  }
}

$('joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('joinBtn').disabled = true;
  try {
    const result = await api('/api/live/join', { method: 'POST', body: { nick: $('nick').value } });
    viewerId = result.viewerId;
    nick = result.nick;
    save();
    say('');
    await refresh();
  } catch (err) {
    say(localizedError(err), true);
  } finally {
    $('joinBtn').disabled = false;
  }
});

$('leaveBtn').addEventListener('click', async () => {
  const id = viewerId;
  viewerId = null;
  nick = null;
  chatMember = false;
  clearChatView();
  updateChatUI();
  save();
  showRoom(false);
  $('turnCard').classList.add('hidden');
  try { await api('/api/live/leave', { method: 'POST', body: { viewerId: id } }); } catch { /* ignore */ }
});

$('chatForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!viewerId || !$('chatInput').value.trim()) return;
  $('chatSend').disabled = true;
  try {
    await api('/api/live/chat/send', {
      method: 'POST',
      body: { viewerId, text: $('chatInput').value },
    });
    $('chatInput').value = '';
    $('chatError').textContent = '';
    await refreshChat();
  } catch (err) {
    if (err.code === 'not_in_queue' || err.code === 'live_disabled') {
      chatMember = false;
      liveEnabled = err.code !== 'live_disabled';
      updateChatUI();
    } else if (err.code === 'chat_disabled') {
      chatEnabled = false;
      updateChatUI();
    }
    $('chatError').textContent = t(errorKeys[err.code] ?? 'errorConnection');
  } finally {
    $('chatSend').disabled = !chatMember || !chatEnabled;
  }
});

applyLanguage();
refresh();
setInterval(refresh, 5000);
setInterval(refreshChat, 5000);
setInterval(updatePlayingClock, 1000);
