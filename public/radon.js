// 氡巡查与通风放行页面：只负责渲染与交互，判定规则在服务端 src/radon.js。
window.RadonPage = (() => {
  const App = () => window.App;

  const OPEN_STATUSES = ['待通风', '待复测'];
  const RETESTS_REQUIRED = 2;

  function siteLabel(id) {
    const site = (App().state.db.sites || []).find((entry) => entry.id === id);
    if (!site) return '未关联样点';
    return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
  }

  function instrumentLabel(id) {
    const inst = (App().state.db.instruments || []).find((entry) => entry.id === id);
    if (!inst) return '未关联仪器';
    return `${inst.code} / ${inst.model}`;
  }

  function instrumentOptions(siteId, selectedId) {
    const { escapeHtml } = App();
    const instruments = App().state.db.instruments || [];
    const options = instruments.map((inst) => {
      const elsewhere = inst.status === '借出' && inst.siteId !== siteId;
      const here = inst.status === '借出' && inst.siteId === siteId;
      const tag = elsewhere ? `（借出至 ${siteLabel(inst.siteId)}）` : here ? '（本点借出中）' : '（在库）';
      const selected = inst.id === selectedId ? 'selected' : '';
      return `<option value="${inst.id}" ${selected} ${elsewhere ? 'disabled' : ''}>${escapeHtml(inst.code)} / ${escapeHtml(inst.model)}${escapeHtml(tag)}</option>`;
    });
    return `<option value="">请选择仪器</option>${options.join('')}`;
  }

  function siteOptions() {
    const { escapeHtml } = App();
    const sites = App().state.db.sites || [];
    const options = sites.map((site) => `<option value="${site.id}">${escapeHtml(siteLabel(site.id))}</option>`);
    return `<option value="">请选择样点</option>${options.join('')}`;
  }

  function readingFormHtml() {
    return `<form class="panel" id="radon-reading-form" data-radon-form="reading">
      <h2>登记氡巡查</h2>
      <div class="form-grid">
        <label class="wide">样点<select name="siteId" required>${siteOptions()}</select></label>
        <label class="wide">仪器<select name="instrumentId" required>${instrumentOptions('')}</select></label>
        <label>操作员<input name="operator" required placeholder="巡测员姓名"></label>
        <label>时段开始<input type="datetime-local" name="periodStart" required></label>
        <label>时段结束<input type="datetime-local" name="periodEnd" required></label>
        <label>氡浓度(Bq/m³)<input type="number" step="any" min="0" name="radon" required></label>
        <label class="wide">平衡当量浓度(Bq/m³)<input type="number" step="any" min="0" name="eec" required></label>
        <label class="wide">备注<textarea name="note" placeholder="仪器状态、洞室环境等"></textarea></label>
      </div>
      <div class="actions">
        <button type="submit">保存巡查</button>
        <button type="button" class="ghost" data-radon-cancel hidden>取消修订</button>
      </div>
      <p class="meta">氡浓度超过 400 Bq/m³ 或平衡当量浓度超过 120，样点转入待通风并暂停讲解许可。</p>
    </form>`;
  }

  function meterHtml(clearance) {
    const pct = clearance.targetVolume > 0
      ? Math.min(100, Math.round((clearance.exchangedVolume / clearance.targetVolume) * 100))
      : 0;
    return `<div class="meter"><span style="width:${pct}%"></span></div>`;
  }

  function retestsHtml(clearance) {
    const { escapeHtml, fmtDate, pill, toneFor } = App();
    if (!clearance.retests?.length) return '';
    const rows = clearance.retests.map((retest) => `
      <div class="history-item">
        <span>${fmtDate(retest.at)}</span>
        <span>${escapeHtml(retest.operator)}：氡 ${retest.radon} Bq/m³，EEC ${retest.eec} ${pill(retest.pass ? '合格' : '超限', toneFor(retest.pass ? '合格' : '超限'))}</span>
      </div>`).join('');
    return `<div class="history">${rows}</div>`;
  }

  function clearanceCardHtml(clearance) {
    const { escapeHtml, pill, toneFor, historyHtml } = App();
    const open = OPEN_STATUSES.includes(clearance.status);
    const remaining = Math.max(0, RETESTS_REQUIRED - (clearance.passes || 0));
    const ventForm = open ? `<form class="mini-form" data-radon-form="ventilation" data-id="${clearance.id}">
        <label>风量(m³/h)<input type="number" step="any" min="0" name="flowRate" required></label>
        <label>时长(h)<input type="number" step="any" min="0" name="hours" required></label>
        <label>操作员<input name="operator" required></label>
        <button type="submit">登记通风</button>
      </form>` : '';
    const retestForm = clearance.status === '待复测' ? `<form class="mini-form" data-radon-form="retest" data-id="${clearance.id}">
        <label>复测巡测员<input name="operator" required placeholder="须为另一位"></label>
        <label>氡浓度(Bq/m³)<input type="number" step="any" min="0" name="radon" required></label>
        <label>EEC(Bq/m³)<input type="number" step="any" min="0" name="eec" required></label>
        <label>复测时间(留空为现在)<input type="datetime-local" name="at"></label>
        <button type="submit">登记复测</button>
      </form>` : '';
    return `<article class="card">
      <div class="card-head"><h3>${escapeHtml(siteLabel(clearance.siteId))}</h3>${pill(clearance.status, toneFor(clearance.status))}</div>
      <div class="meta">换气量 <strong>${clearance.exchangedVolume}</strong> / ${clearance.targetVolume} m³（洞室容积 3 倍） · 还差 <strong>${remaining}</strong> 次复测</div>
      ${meterHtml(clearance)}
      ${ventForm}
      ${retestForm}
      ${retestsHtml(clearance)}
      ${historyHtml(clearance)}
    </article>`;
  }

  function clearanceBoardHtml() {
    const clearances = [...(App().state.db.clearances || [])];
    const open = clearances.filter((entry) => OPEN_STATUSES.includes(entry.status));
    const closed = clearances.filter((entry) => !OPEN_STATUSES.includes(entry.status));
    const openHtml = open.length ? open.map(clearanceCardHtml).join('') : '<div class="empty">暂无进行中的放行</div>';
    const closedHtml = closed.length
      ? `<h3 class="subhead">历史放行（旧记录）</h3><div class="list">${closed.map(clearanceCardHtml).join('')}</div>`
      : '';
    return `<div class="list">${openHtml}</div>${closedHtml}`;
  }

  function readingCardHtml(reading) {
    const { escapeHtml, fmtDate, pill, toneFor, historyHtml } = App();
    const inst = (App().state.db.instruments || []).find((entry) => entry.id === reading.instrumentId);
    const instState = inst ? (inst.status === '借出' ? `借出至 ${siteLabel(inst.siteId)}` : '已归还') : '';
    return `<article class="card">
      <div class="card-head"><h3>${escapeHtml(siteLabel(reading.siteId))}</h3>${pill(reading.verdict, toneFor(reading.verdict))}</div>
      <div class="meta">${escapeHtml(reading.operator)} · ${fmtDate(reading.periodStart)} ~ ${fmtDate(reading.periodEnd)}</div>
      <div class="detail">
        <div>氡浓度<br><strong>${reading.radon} Bq/m³</strong></div>
        <div>平衡当量浓度<br><strong>${reading.eec}</strong></div>
        <div>仪器<br><strong>${escapeHtml(instrumentLabel(reading.instrumentId))}</strong><br><span class="meta">${escapeHtml(instState)}</span></div>
      </div>
      ${reading.note ? `<p>${escapeHtml(reading.note)}</p>` : ''}
      <div class="actions"><button class="ghost" data-radon-edit="${reading.id}">修订读数</button></div>
      ${historyHtml(reading)}
    </article>`;
  }

  function render(view) {
    const readings = App().state.db.radonReadings || [];
    const readingsHtml = readings.length
      ? readings.map(readingCardHtml).join('')
      : '<div class="empty">暂无氡巡查记录</div>';
    return `<section class="view" id="${view.id}">
      <div class="grid">
        ${readingFormHtml()}
        <div class="panel">
          <h2>放行看板</h2>
          ${clearanceBoardHtml()}
        </div>
      </div>
      <div class="panel radon-readings">
        <h2>氡巡查记录</h2>
        <div class="list">${readingsHtml}</div>
      </div>
    </section>`;
  }

  function readingPayload(form) {
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.radon = Number(payload.radon);
    payload.eec = Number(payload.eec);
    return payload;
  }

  function resetReadingForm(form) {
    delete form.dataset.editing;
    form.querySelector('[type="submit"]').textContent = '保存巡查';
    form.querySelector('[data-radon-cancel]').hidden = true;
    form.querySelector('h2').textContent = '登记氡巡查';
    form.reset();
    form.elements.siteId.disabled = false;
    form.elements.instrumentId.disabled = false;
  }

  async function submitReading(form) {
    const editing = form.dataset.editing;
    const payload = readingPayload(form);
    if (editing) {
      await App().api(`/api/radon/readings/${editing}`, { method: 'PATCH', body: JSON.stringify(payload) });
      App().toast('修订已保存，未结束放行已按新值重判');
    } else {
      const result = await App().api('/api/radon/readings', { method: 'POST', body: JSON.stringify(payload) });
      const verdict = result.reading?.verdict || '';
      App().toast(result.clearance ? `已保存：${verdict}，样点转入待通风` : `已保存：${verdict}`);
    }
    await App().load();
  }

  async function submitVentilation(form) {
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.flowRate = Number(payload.flowRate);
    payload.hours = Number(payload.hours);
    await App().api(`/api/radon/clearances/${form.dataset.id}/ventilations`, { method: 'POST', body: JSON.stringify(payload) });
    App().toast('通风已登记');
    await App().load();
  }

  async function submitRetest(form) {
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.radon = Number(payload.radon);
    payload.eec = Number(payload.eec);
    if (!payload.at) delete payload.at;
    const result = await App().api(`/api/radon/clearances/${form.dataset.id}/retests`, { method: 'POST', body: JSON.stringify(payload) });
    const clearance = result.clearance;
    if (clearance?.status === '已放行') {
      App().toast('两次复测均合格，已恢复常规观察');
    } else {
      const remaining = Math.max(0, RETESTS_REQUIRED - (clearance?.passes || 0));
      App().toast(`复测已登记，还差 ${remaining} 次复测`);
    }
    await App().load();
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-radon-form]');
    if (!form) return;
    event.preventDefault();
    try {
      if (form.dataset.radonForm === 'reading') await submitReading(form);
      if (form.dataset.radonForm === 'ventilation') await submitVentilation(form);
      if (form.dataset.radonForm === 'retest') await submitRetest(form);
    } catch (error) {
      App().toast(error.message);
    }
  });

  document.addEventListener('click', (event) => {
    const edit = event.target.closest('[data-radon-edit]');
    const cancel = event.target.closest('[data-radon-cancel]');
    if (edit) {
      const reading = (App().state.db.radonReadings || []).find((entry) => entry.id === edit.dataset.radonEdit);
      const form = document.querySelector('#radon-reading-form');
      if (!reading || !form) return;
      form.elements.siteId.value = reading.siteId;
      form.elements.instrumentId.innerHTML = instrumentOptions(reading.siteId, reading.instrumentId);
      form.elements.instrumentId.value = reading.instrumentId;
      form.elements.operator.value = reading.operator;
      form.elements.periodStart.value = reading.periodStart;
      form.elements.periodEnd.value = reading.periodEnd;
      form.elements.radon.value = reading.radon;
      form.elements.eec.value = reading.eec;
      form.elements.note.value = reading.note || '';
      form.elements.siteId.disabled = true;
      form.elements.instrumentId.disabled = true;
      form.dataset.editing = reading.id;
      form.querySelector('[type="submit"]').textContent = '保存修订';
      form.querySelector('[data-radon-cancel]').hidden = false;
      form.querySelector('h2').textContent = '修订氡读数';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (cancel) resetReadingForm(cancel.closest('form'));
  });

  document.addEventListener('change', (event) => {
    const select = event.target.closest('#radon-reading-form select[name="siteId"]');
    if (!select) return;
    const form = select.closest('form');
    form.elements.instrumentId.innerHTML = instrumentOptions(select.value);
  });

  return { render };
})();
