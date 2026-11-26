import { api } from './common.js';

const $ = (id) => document.getElementById(id);
const KEY = 'xp_live_viewer';

let viewerId = null;
let nick = null;
let shownVideo = null;

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

function showRoom(joined, name) {
  $('joinForm').classList.toggle('hidden', joined);
  $('inRoom').classList.toggle('hidden', !joined);
  if (joined) $('inRoomNick').textContent = name ?? '';
}

function mountVideo(videoId) {
  if (shownVideo === videoId) return;
  shownVideo = videoId;
  const id = encodeURIComponent(videoId);
  $('player').src = `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;
  if (isMobileWeb()) {
    $('chat').removeAttribute('src');
    $('chatEmbed').classList.add('hidden');
    $('youtubeChatLink').href = `https://www.youtube.com/watch?v=${id}`;
    $('chatMobile').classList.remove('hidden');
  } else {
    $('chatMobile').classList.add('hidden');
    $('chatEmbed').classList.remove('hidden');
    $('chat').src = `https://www.youtube.com/live_chat?v=${id}&embed_domain=${encodeURIComponent(location.hostname)}`;
  }
}

async function refresh() {
  try {
    const info = await api('/api/live');
    $('offCard').classList.toggle('hidden', info.enabled);
    $('liveGrid').classList.toggle('hidden', !info.enabled);
    if (info.enabled) {
      mountVideo(info.videoId);
      $('roomBadge').textContent = `${info.viewers} na sala`;
    } else if (shownVideo) {
      shownVideo = null;
      $('player').removeAttribute('src');
      $('chat').removeAttribute('src');
    }

    if (viewerId) {
      const me = await api(`/api/live/me?v=${encodeURIComponent(viewerId)}`);
      if (me.chosen) {
        $('turnCard').classList.remove('hidden');
        $('turnNick').textContent = me.nick;
        $('turnBtn').href = me.playUrl;
        $('turnHint').textContent = me.sessionStatus === 'provisioning'
          ? 'Preparando a transmissão... o botão já funciona. O tempo começa quando a imagem aparecer.'
          : 'Entre agora; no celular ou tablet, os comandos aparecem na tela.';
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
    say(err.message, true);
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
    say(err.message, true);
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

refresh();
setInterval(refresh, 5000);
