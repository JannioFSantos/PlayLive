import {
  api,
  fmtClock,
  fmtDateTime,
  fmtTime,
  esc,
  toast,
  copyText,
  remainingFrom,
  setServerNow,
} from './common.js';

const $ = (id) => document.getElementById(id);

let overview = null;
let pollTimer = null;
let lastEventAt = 0;
let adminWs = null;

boot();

async function boot() {
  bindStaticUI();
  try {
    const { admin } = await api('/api/admin/session');
    if (admin) enterDashboard();
    else showLogin();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('loginCard').classList.remove('hidden');
  $('dashboard').classList.add('hidden');
  $('btnLogout').classList.add('hidden');
}

function enterDashboard() {
  $('loginCard').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('btnLogout').classList.remove('hidden');
  load();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) load(true);
  }, 2500);
  setInterval(updateClocks, 500);
}

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */

function bindStaticUI() {
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('loginBtn');
    button.disabled = true;
    button.textContent = 'Entrando…';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      enterDashboard();
    } catch (err) {
      toast(err.message, 'danger');
      button.disabled = false;
      button.textContent = 'Entrar';
    }
  });

  $('btnLogout').addEventListener('click', async (event) => {
    event.preventDefault();
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  $('btnRevealKey').addEventListener('click', async () => {
    try {
      const { hostKey } = await api('/api/admin/host-key');
      const box = $('hostKeyBox');
      box.classList.remove('hidden');
      box.innerHTML = `<div class="row between" style="gap: 8px;">
        <span id="keyValue" style="word-break: break-all;">${esc(hostKey)}</span>
        <button class="btn btn-ghost btn-sm" id="btnCopyKey">copiar</button>
      </div>`;
      $('btnCopyKey').addEventListener('click', async () => {
        const ok = await copyText(hostKey);
        toast(ok ? 'Chave copiada.' : 'Copie manualmente.', ok ? 'green' : 'warn');
      });
    } catch (err) {
      toast(err.message, 'danger');
    }
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    handleAction(btn).catch((err) => toast(err.message, 'danger'));
  });
}

/* ------------------------------------------------------------------ */
/* Carga                                                              */
/* ------------------------------------------------------------------ */

async function load(silent = false) {
  try {
    overview = await api('/api/admin/overview');
    setServerNow(overview.serverNow);
    render();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      clearInterval(pollTimer);
      showLogin();
      if (!silent) toast('Sessão do painel expirou. Entre de novo.', 'warn');
      return;
    }
    if (!silent) toast(err.message, 'danger');
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                             */
/* ------------------------------------------------------------------ */

function render() {
  if (!overview) return;
  renderLive();
  const { session, presence, counters, events, config } = overview;

  $('modeDot').className = `dot ${overview.live?.enabled ? 'live' : 'warn'}`;
  $('modeText').textContent = overview.live?.enabled ? 'sala aberta' : 'sala fechada';

  const slotMap = { free: ['livre', 'green'], busy: ['em uso', 'warn'] };
  const [slotText, slotClass] = slotMap[overview.slot?.status] ?? ['—', ''];
  $('slotBadge').className = `badge ${slotClass}`;
  $('slotBadge').innerHTML = `<span class="dot ${slotClass === 'green' ? 'live' : 'busy'}"></span>${slotText}`;

  // Presença
  $('presenceHost').textContent = presence.host ? 'online' : 'offline';
  $('presenceViewer').textContent = presence.viewer ? 'conectado' : '—';
  $('presenceBridge').textContent = presence.bridge ? 'online' : '—';
  $('presenceAdmins').textContent = String(presence.admins ?? 0);

  // Contadores
  $('counterSessions').textContent = String(counters.sessionsTotal ?? 0);
  $('counterMinutes').textContent = `${counters.minutesPlayed ?? 0} min`;

  // Sessão
  const active = session && ['provisioning', 'active'].includes(session.status);
  const label = session
    ? session.status === 'active' ? 'ativa' : session.status === 'provisioning' ? 'preparando' : 'encerrada'
    : 'livre';
  $('sessionBadge').className = `badge ${active ? 'green' : ''}`;
  $('sessionBadge').innerHTML = `<span class="dot ${active ? 'live' : ''}"></span>${label}`;
  $('sessionMinutes').textContent = session ? `${session.minutes} min` : '—';
  $('sessionPlayer').textContent = session?.player ?? '—';
  $('sessionStart').textContent = session?.startedAt ? fmtDateTime(session.startedAt) : '—';
  $('sessionEnd').textContent = session?.endsAt ? fmtDateTime(session.endsAt) : '—';
  $('sessionViewer').textContent = session ? (session.viewerConnected ? 'sim' : 'não') : '—';
  $('sessionStream').textContent = session ? (session.streamReady ? 'sim' : 'não') : '—';

  const openPlay = $('btnOpenPlay');
  if (active && session.playUrl) {
    openPlay.href = session.playUrl;
    openPlay.classList.remove('hidden');
  } else {
    openPlay.removeAttribute('href');
    openPlay.classList.add('hidden');
  }
  document.querySelectorAll('#sessionActions [data-action]').forEach((btn) => {
    btn.disabled = !active;
  });

  // Eventos
  const newEvents = events.filter((entry) => entry.at > lastEventAt);
  if (newEvents.length && lastEventAt) {
    const latest = newEvents[0];
    if (['session.created', 'session.ended', 'session.provision_failed'].includes(latest.type)) {
      toast(eventLabel(latest.type), latest.level === 'warn' ? 'warn' : 'green');
    }
  }
  if (events.length) lastEventAt = Math.max(lastEventAt, events[0].at);

  $('eventsBadge').textContent = String(events.length);
  $('eventLog').innerHTML = events.map((entry) => `
    <div class="entry ${esc(entry.level)}">
      <time>${new Date(entry.at).toLocaleTimeString('pt-BR')}</time>
      <span class="type">${esc(entry.type)}</span>
      <span class="detail" title="${esc(JSON.stringify(entry.detail ?? {}))}">${esc(JSON.stringify(entry.detail ?? {}))}</span>
    </div>`).join('');

  $('configLine').textContent = [
    `máx ${config.maxMinutes} min por pessoa`,
    `tempo para a imagem subir ${config.provisionTimeoutSec}s`,
    config.xboxPowerConfigured ? 'energia do Xbox ok' : 'energia do Xbox não configurada',
  ].join(' · ');

  updateClocks();
}

function eventLabel(type) {
  return {
    'session.created': 'Jogador escolhido: sessão criada.',
    'session.ended': 'Sessão encerrada.',
    'session.provision_failed': 'A imagem não subiu a tempo: sessão encerrada.',
  }[type] ?? type;
}

function updateClocks() {
  if (!overview?.session?.endsAt) {
    $('sessionClock').textContent = overview?.session ? '—' : '—';
  } else {
    const left = remainingFrom(overview.session.endsAt);
    $('sessionClock').textContent = overview.session.status === 'active' ? fmtClock(left) : '—';
    $('sessionClock').classList.toggle('warn', left <= 5 * 60_000 && left > 60_000);
    $('sessionClock').classList.toggle('danger', left <= 60_000 && left > 0);
  }

}

/* ------------------------------------------------------------------ */
/* Ações                                                              */
/* ------------------------------------------------------------------ */

const confirmations = {
  end_session: 'Encerrar a sessão agora? O jogador perde o tempo restante.',
  reset_session_state: 'Reset de emergência: encerra a sessão e libera a máquina. Continuar?',
};

async function handleAction(btn) {
  const action = btn.dataset.action;

  if (action === 'extend') {
    const minutes = Number(btn.dataset.minutes);
    btn.disabled = true;
    try {
      await api('/api/admin/action', { method: 'POST', body: { action: 'extend', minutes } });
      toast(`+${minutes} min aplicados.`, 'green');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (action === 'xbox_power') {
    btn.disabled = true;
    try {
      const result = await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'xbox_power', mode: btn.dataset.mode },
      });
      toast(result.ok ? `Comando executado (${btn.dataset.mode}).` : 'Comando falhou. Veja o log.', result.ok ? 'green' : 'danger');
      await load(true);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (confirmations[action] && !confirm(confirmations[action])) return;

  btn.disabled = true;
  try {
    await api('/api/admin/action', { method: 'POST', body: { action } });
    toast('Feito.', 'green');
    await load(true);
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Live do YouTube                                                    */
/* ------------------------------------------------------------------ */

function renderLive() {
  const live = overview?.live;
  if (!live || !$('liveCard')) return;
  $('liveBadge').textContent = live.enabled ? 'sala aberta' : 'desligada';
  $('liveBadge').className = `badge ${live.enabled ? 'green' : ''}`;
  $('liveCount').textContent = `${live.viewers.length} na sala`;
  const chat = live.chat ?? { enabled: false, messageCount: 0 };
  $('liveChatStatus').textContent = `Chat ${chat.enabled ? 'ativo' : 'pausado'} · ${chat.messageCount} mensagens`;
  $('liveChatToggle').textContent = chat.enabled ? 'pausar chat' : 'abrir chat';
  $('liveChatToggle').disabled = !live.enabled;
  $('liveChatClear').disabled = !live.enabled || chat.messageCount === 0;
  if (!$('liveMinutes').dataset.init && overview.config) {
    $('liveMinutes').value = overview.config.defaultMinutes;
    $('liveMinutes').max = overview.config.maxMinutes;
    $('liveMinutes').dataset.init = '1';
  }
  // Não sobrescreve o que a pessoa está digitando.
  if (document.activeElement !== $('liveUrl') && !$('liveUrl').dataset.dirty) {
    $('liveUrl').value = live.videoId ? `https://www.youtube.com/watch?v=${live.videoId}` : '';
  }
  if (document.activeElement !== $('liveEnabled')) $('liveEnabled').checked = live.enabled;

  $('liveViewers').innerHTML = live.viewers.length
    ? live.viewers.map((v) => `
        <div class="list-item">
          <div class="main"><strong>${esc(v.nick)}</strong><small>entrou ${fmtTime(v.joinedAt)}</small></div>
          <button class="btn btn-primary btn-sm" data-live="pick" data-pub="${esc(v.pub)}">escolher</button>
          <button class="btn btn-ghost btn-sm" data-live="kick" data-pub="${esc(v.pub)}">remover</button>
        </div>`).join('')
    : '<p class="tiny muted" style="margin: 0;">Ninguém na sala ainda.</p>';
}

$('liveUrl')?.addEventListener('input', () => { $('liveUrl').dataset.dirty = '1'; });

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-live]');
  if (!btn) return;
  const kind = btn.dataset.live;
  btn.disabled = true;
  try {
    if (kind === 'save') {
      await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'live_set', url: $('liveUrl').value, enabled: $('liveEnabled').checked },
      });
      delete $('liveUrl').dataset.dirty;
      toast('Live salva.', 'green');
    } else if (kind === 'pick') {
      const minutes = Number($('liveMinutes').value);
      const result = await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'live_pick', pub: btn.dataset.pub, minutes },
      });
      toast(`${result.nick} vai jogar por ${result.minutes} min.`, 'green');
    } else if (kind === 'kick') {
      await api('/api/admin/action', { method: 'POST', body: { action: 'live_kick', pub: btn.dataset.pub } });
    } else if (kind === 'chat-toggle') {
      await api('/api/admin/action', {
        method: 'POST',
        body: { action: 'live_chat_toggle', enabled: !overview.live.chat.enabled },
      });
    } else if (kind === 'chat-clear') {
      await api('/api/admin/action', { method: 'POST', body: { action: 'live_chat_clear' } });
    }
    await load(true);
  } catch (err) {
    toast(err.message, 'danger');
  } finally {
    btn.disabled = false;
  }
});
