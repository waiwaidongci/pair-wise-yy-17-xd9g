// 氡巡查页面层：只负责渲染与交互，判定结果来自 /api/radon/overview。
window.RadonPage = (() => {
  const esc = (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const fmt = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-');

  const localInputValue = (date = new Date()) => {
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const pill = (value, tone = '') => `<span class="pill ${tone}">${esc(value || '-')}</span>`;
  const tone = (value) => (window.AppTone ? window.AppTone(value) : '');

  const siteLabel = (site) => [site?.cave, site?.zone, site?.pointCode].filter(Boolean).join(' / ') || '未知样点';

  function siteOptions(sites, filter = () => true) {
    return sites.filter(filter)
      .map((site) => `<option value="${site.id}">${esc(siteLabel(site))}</option>`)
      .join('');
  }

  function instrumentOptions(overview) {
    return overview.instruments.map((instrument) => {
      const where = instrument.checkout
        ? `借出至 ${esc(siteLabel(overview.sites.find((site) => site.id === instrument.checkout.siteId)))}`
        : '在库';
      return `<option value="${instrument.id}">${esc(instrument.code)} ${esc(instrument.name)}（${where}）</option>`;
    }).join('');
  }

  function readingForm(overview) {
    return `<form class="panel" data-radon="reading">
      <h2>登记氡巡查</h2>
      <div class="form-grid">
        <label class="wide">样点<select name="siteId" required>${siteOptions(overview.sites)}</select></label>
        <label class="wide">仪器<select name="instrumentId" required>${instrumentOptions(overview)}</select></label>
        <label>时段开始<input type="datetime-local" name="periodStart" value="${localInputValue()}" required></label>
        <label>时段结束<input type="datetime-local" name="periodEnd" value="${localInputValue()}" required></label>
        <label>氡浓度 (Bq/m³)<input type="number" name="radon" min="0" step="any" required></label>
        <label>平衡当量浓度<input type="number" name="eec" min="0" step="any" required></label>
        <label class="wide">操作员<input name="operator" required></label>
      </div>
      <div class="actions"><button>保存巡查</button></div>
    </form>`;
  }

  function ventilationForm(overview) {
    const pending = overview.sites.filter((site) => site.radonStatus === '待通风');
    return `<form class="panel" data-radon="ventilation">
      <h2>登记通风</h2>
      <div class="form-grid">
        <label class="wide">待通风样点<select name="siteId" required>${siteOptions(pending)}</select></label>
        <label>风量 (m³/h)<input type="number" name="airFlow" min="0" step="any" required></label>
        <label>时长 (h)<input type="number" name="duration" min="0" step="any" required></label>
        <label>时间<input type="datetime-local" name="at" value="${localInputValue()}" required></label>
        <label>操作员<input name="operator" required></label>
      </div>
      <div class="actions"><button ${pending.length ? '' : 'disabled'}>保存通风</button></div>
      ${pending.length ? '' : '<p class="meta">暂无待通风样点</p>'}
    </form>`;
  }

  function retestForm(overview) {
    const pending = overview.sites.filter((site) => site.radonStatus === '待通风');
    return `<form class="panel" data-radon="retest">
      <h2>登记复测</h2>
      <div class="form-grid">
        <label class="wide">待通风样点<select name="siteId" required>${siteOptions(pending)}</select></label>
        <label>复测巡测员<input name="surveyor" required></label>
        <label>复测时间<input type="datetime-local" name="at" value="${localInputValue()}" required></label>
        <label>氡浓度 (Bq/m³)<input type="number" name="radon" min="0" step="any" required></label>
        <label>平衡当量浓度<input type="number" name="eec" min="0" step="any" required></label>
      </div>
      <div class="actions"><button ${pending.length ? '' : 'disabled'}>保存复测</button></div>
      <p class="meta">须由另一位巡测员在换气达标后隔 ${overview.limits.retestGapMinutes} 分钟复测，连续 ${overview.limits.retestsRequired} 次低于限值才恢复常规观察。</p>
    </form>`;
  }

  function reviseForm(overview) {
    const active = overview.readings.filter((reading) => reading.status !== '已修订');
    const options = active.map((reading) => {
      const site = overview.sites.find((entry) => entry.id === reading.siteId);
      return `<option value="${reading.id}">${esc(siteLabel(site))} · ${esc(reading.operator)} · 氡${reading.radon} / 等效${reading.eec}</option>`;
    }).join('');
    return `<form class="panel" data-radon="revise">
      <h2>修订读数</h2>
      <div class="form-grid">
        <label class="wide">原读数<select name="readingId" required>${options}</select></label>
        <label>新氡浓度 (Bq/m³)<input type="number" name="radon" min="0" step="any" required></label>
        <label>新平衡当量浓度<input type="number" name="eec" min="0" step="any" required></label>
        <label class="wide">修订说明<input name="note"></label>
      </div>
      <div class="actions"><button ${active.length ? '' : 'disabled'}>提交修订</button></div>
      <p class="meta">修订后旧读数留档可查，未结束放行失效并按新值重判。</p>
    </form>`;
  }

  function volumeForm(overview) {
    return `<form class="panel" data-radon="volume">
      <h2>修订洞室容积</h2>
      <div class="form-grid">
        <label class="wide">样点<select name="siteId" required>${siteOptions(overview.sites)}</select></label>
        <label>新容积 (m³)<input type="number" name="chamberVolume" min="0" step="any" required></label>
      </div>
      <div class="actions"><button>提交修订</button></div>
      <p class="meta">容积变化会让未结束放行失效，并按新容积重算 ${overview.limits.airMultiple} 倍换气量。</p>
    </form>`;
  }

  function progressBar(ratio) {
    const percent = Math.min(100, Math.round(ratio * 100));
    return `<div class="progress"><div class="progress-inner" style="width:${percent}%"></div></div>`;
  }

  function siteCard(site, overview) {
    const c = site.clearance;
    const pending = site.radonStatus === '待通风';
    const last = site.lastReading;
    const checkout = overview.instruments.find((instrument) => instrument.checkout?.siteId === site.id);
    const details = `<div class="detail">
      <div>洞室容积<br><strong>${esc(site.chamberVolume ?? '-')} m³</strong></div>
      <div>换气量<br><strong>${c.ventilatedAir} / ${c.requiredAir} m³</strong><br><span class="meta">还差 ${c.airRemaining} m³</span></div>
      <div>复测<br><strong>${pending ? `还差 ${c.retestsRemaining} 次` : '无需复测'}</strong><br><span class="meta">已连续合格 ${c.retestsPassed} 次</span></div>
      <div>最近读数<br><strong>${last ? `氡 ${last.radon} / 等效 ${last.eec}` : '暂无'}</strong><br><span class="meta">${last ? esc(last.operator) : ''}</span></div>
      <div>在借仪器<br><strong>${checkout ? esc(checkout.code) : '无'}</strong><br><span class="meta">${checkout ? esc(checkout.checkout.operator) : ''}</span></div>
      <div>下次可复测<br><strong>${pending ? fmt(c.nextRetestAt) : '-'}</strong></div>
    </div>`;
    const history = (site.history || []).slice(0, 4).map((entry) => `
      <div class="history-item"><span>${fmt(entry.at)}</span><span>${esc(entry.action)}${entry.note ? '：' + esc(entry.note) : ''}</span></div>
    `).join('');
    return `<article class="card">
      <div class="card-head"><h3>${esc(site.pointCode)} / ${esc(site.zone)}</h3><span>${pill(site.radonStatus, tone(site.radonStatus))} ${pill(site.permitStatus, tone(site.permitStatus))}</span></div>
      <div class="meta">${esc(site.cave)} · 限值：氡 ≤ ${overview.limits.radon} Bq/m³，等效 ≤ ${overview.limits.eec}</div>
      ${pending ? progressBar(c.requiredAir ? c.ventilatedAir / c.requiredAir : 0) : ''}
      ${details}
      ${history ? `<div class="history">${history}</div>` : ''}
    </article>`;
  }

  function progressPanel(overview) {
    const cards = overview.sites.map((site) => siteCard(site, overview)).join('');
    return `<div class="panel"><h2>放行进度</h2><div class="list">${cards || '<div class="empty">暂无样点</div>'}</div></div>`;
  }

  function instrumentPanel(overview) {
    const items = overview.instruments.map((instrument) => {
      const status = instrument.checkout ? '借出' : '在库';
      const where = instrument.checkout
        ? siteLabel(overview.sites.find((site) => site.id === instrument.checkout.siteId))
        : '可借用';
      return `<article class="card"><div class="card-head"><h3>${esc(instrument.code)} ${esc(instrument.name)}</h3>${pill(status, tone(status))}</div>
        <div class="meta">${esc(instrument.model || '')} · ${esc(where)}</div></article>`;
    }).join('');
    return `<div class="panel"><h2>仪器状态</h2><div class="list">${items || '<div class="empty">暂无仪器</div>'}</div></div>`;
  }

  function readingCard(reading, overview) {
    const site = overview.sites.find((entry) => entry.id === reading.siteId);
    const instrument = overview.instruments.find((entry) => entry.id === reading.instrumentId);
    const exceeded = Number(reading.radon) > overview.limits.radon || Number(reading.eec) > overview.limits.eec;
    const actions = [];
    if (reading.status !== '已修订' && !reading.returnedAt) {
      actions.push(`<button class="ghost" data-radon-return="${reading.id}">仪器归还</button>`);
    }
    if (reading.status !== '已修订') {
      actions.push(`<button class="ghost" data-radon-fill-revise="${reading.id}">修订</button>`);
    }
    return `<article class="card">
      <div class="card-head"><h3>${esc(siteLabel(site))}</h3><span>${pill(reading.status, tone(reading.status))} ${pill(exceeded ? '超限' : '合格', exceeded ? 'bad' : 'ok')}</span></div>
      <div class="meta">${esc(instrument ? `${instrument.code} ${instrument.name}` : '未知仪器')} · 操作员 ${esc(reading.operator)} · 时段 ${fmt(reading.periodStart)} ~ ${fmt(reading.periodEnd)}</div>
      <div class="detail">
        <div>氡浓度<br><strong>${reading.radon} Bq/m³</strong></div>
        <div>平衡当量浓度<br><strong>${reading.eec}</strong></div>
        <div>仪器归还<br><strong>${reading.returnedAt ? fmt(reading.returnedAt) : '未归还'}</strong></div>
      </div>
      ${reading.revisionOf ? `<div class="meta">修订自 ${esc(reading.revisionOf)}</div>` : ''}
      ${reading.supersededBy ? `<div class="meta">已被 ${esc(reading.supersededBy)} 修订，旧记录留档</div>` : ''}
      ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
    </article>`;
  }

  function ventilationCard(record, overview) {
    const site = overview.sites.find((entry) => entry.id === record.siteId);
    return `<article class="card">
      <div class="card-head"><h3>${esc(siteLabel(site))}</h3>${pill(record.status, tone(record.status))}</div>
      <div class="meta">${fmt(record.at)} · 操作员 ${esc(record.operator)}</div>
      <div class="detail">
        <div>风量<br><strong>${record.airFlow} m³/h</strong></div>
        <div>时长<br><strong>${record.duration} h</strong></div>
        <div>换气量<br><strong>${record.exchange} m³</strong></div>
      </div>
    </article>`;
  }

  function retestCard(record, overview) {
    const site = overview.sites.find((entry) => entry.id === record.siteId);
    return `<article class="card">
      <div class="card-head"><h3>${esc(siteLabel(site))}</h3><span>${pill(record.status, tone(record.status))} ${pill(record.passed ? '合格' : '超限', record.passed ? 'ok' : 'bad')}</span></div>
      <div class="meta">${fmt(record.at)} · 巡测员 ${esc(record.surveyor)}</div>
      <div class="detail">
        <div>氡浓度<br><strong>${record.radon} Bq/m³</strong></div>
        <div>平衡当量浓度<br><strong>${record.eec}</strong></div>
      </div>
    </article>`;
  }

  function archivePanel(overview) {
    return `<div class="panel"><h2>存档记录</h2>
      <h3>氡巡查记录</h3>
      <div class="list">${overview.readings.map((reading) => readingCard(reading, overview)).join('') || '<div class="empty">暂无氡巡查记录</div>'}</div>
      <h3>通风记录</h3>
      <div class="list">${overview.ventilations.map((record) => ventilationCard(record, overview)).join('') || '<div class="empty">暂无通风记录</div>'}</div>
      <h3>复测记录</h3>
      <div class="list">${overview.retests.map((record) => retestCard(record, overview)).join('') || '<div class="empty">暂无复测记录</div>'}</div>
    </div>`;
  }

  function render(view, state) {
    const overview = state.radon;
    if (!overview) {
      return `<section class="view" id="${view.id}"><div class="panel"><div class="empty">氡巡查数据加载失败</div></div></section>`;
    }
    return `<section class="view" id="${view.id}">
      <div class="grid">
        ${readingForm(overview)}
        ${progressPanel(overview)}
      </div>
      <div class="grid">
        ${ventilationForm(overview)}
        ${retestForm(overview)}
      </div>
      <div class="grid">
        ${reviseForm(overview)}
        ${volumeForm(overview)}
      </div>
      <div class="grid">
        ${instrumentPanel(overview)}
        ${archivePanel(overview)}
      </div>
    </section>`;
  }

  const endpoints = {
    reading: () => '/api/radon/readings',
    ventilation: () => '/api/radon/ventilations',
    retest: () => '/api/radon/retests',
    revise: (payload) => `/api/radon/readings/${payload.readingId}/revise`,
    volume: (payload) => `/api/radon/sites/${payload.siteId}/volume`
  };

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-radon]');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.radon;
    const payload = Object.fromEntries(new FormData(form).entries());
    for (const key of ['radon', 'eec', 'airFlow', 'duration', 'chamberVolume']) {
      if (payload[key] !== undefined && payload[key] !== '') payload[key] = Number(payload[key]);
    }
    try {
      const res = await fetch(endpoints[kind](payload), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || '请求失败');
      form.reset();
      await window.AppReload();
      window.AppToast('已保存');
    } catch (error) {
      window.AppToast(error.message);
    }
  });

  document.addEventListener('click', async (event) => {
    const returnBtn = event.target.closest('[data-radon-return]');
    if (returnBtn) {
      try {
        const res = await fetch(`/api/radon/readings/${returnBtn.dataset.radonReturn}/return`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || '请求失败');
        await window.AppReload();
        window.AppToast('仪器已归还');
      } catch (error) {
        window.AppToast(error.message);
      }
      return;
    }
    const fillBtn = event.target.closest('[data-radon-fill-revise]');
    if (fillBtn) {
      const select = document.querySelector('form[data-radon="revise"] select[name="readingId"]');
      if (select) {
        select.value = fillBtn.dataset.radonFillRevise;
        select.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  });

  return { render };
})();
