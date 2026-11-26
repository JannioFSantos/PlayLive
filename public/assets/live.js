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
  lobby_full: 'errorLobbyFull',
  rate_limited: 'errorRateLimited',
  internal: 'errorInternal',
};

let viewerId = null;
let nick = null;
let shownVideo = null;
let playingDeadline = null;

function applyLanguage() {
  document.documentElement.lang = language === 'pt' ? 'pt-BR' : language;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  $('turnTitle').textContent = t('turnTitle', { nick: '' });
  $('nick').placeholder = t('nicknamePlaceholder');
  $('player').title = t('playerTitle');
  $('chat').title = t('chatFrameTitle');
}

function localizedError(error) {
  const key = errorKeys[error.code];
  if (key) return t(key);
  return error.status ? error.message : t('errorConnection');
}

function isMobileWeb() {
  return navigator.userAgentData?.mobile === true
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.matchMedia?.('(pointer: coarse)').matches);
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
  if (isMobileWeb()) {
    $('chat').removeAttribute('src');
    $('chatEmbed').classList.add('hidden');
    $('youtubeChatLink').href = `https://www.youtube.com/watch?v=${id}${languageParam}`;
    $('chatMobile').classList.remove('hidden');
  } else {
    $('chatMobile').classList.add('hidden');
    $('chatEmbed').classList.remove('hidden');
    $('chat').src = `https://www.youtube.com/live_chat?v=${id}&embed_domain=${encodeURIComponent(location.hostname)}${languageParam}`;
  }
}

async function refresh() {
  try {
    const info = await api('/api/live');
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
      $('chat').removeAttribute('src');
    }

    if (viewerId) {
      const me = await api(`/api/live/me?v=${encodeURIComponent(viewerId)}`);
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
          save();
          showRoom(false);
        }
      }
    } else {
      $('turnCard').classList.add('hidden');
      showRoom(false);
    }
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
  save();
  showRoom(false);
  $('turnCard').classList.add('hidden');
  try { await api('/api/live/leave', { method: 'POST', body: { viewerId: id } }); } catch { /* ignore */ }
});

applyLanguage();
refresh();
setInterval(refresh, 5000);
setInterval(updatePlayingClock, 1000);
