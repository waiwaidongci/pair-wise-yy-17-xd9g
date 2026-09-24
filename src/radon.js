// 判定层：氡巡查与通风放行的全部业务规则，不碰文件、不碰 HTTP。
// 所有函数接收内存中的 db 对象并直接修改，由路由层决定何时落盘。
const { newId, pushHistory, touch, byId } = require('./store');

const LIMITS = { radon: 400, eec: 120 }; // 氡浓度 Bq/m³、平衡当量浓度
const AIR_EXCHANGE_RATIO = 3; // 换气量须达到洞室容积的倍数
const RETESTS_REQUIRED = 2; // 连续合格复测次数
const RETEST_INTERVAL_MS = 30 * 60 * 1000; // 两次复测最小间隔

const OPEN_STATUSES = ['待通风', '待复测'];

function exceedsLimits(reading) {
  return Number(reading.radon) > LIMITS.radon || Number(reading.eec) > LIMITS.eec;
}

function openClearanceFor(db, siteId) {
  return (db.clearances || []).find((entry) => entry.siteId === siteId && OPEN_STATUSES.includes(entry.status));
}

function latestReadingFor(db, siteId) {
  const readings = (db.radonReadings || []).filter((entry) => entry.siteId === siteId);
  if (!readings.length) return null;
  return readings.sort((a, b) => new Date(b.periodEnd || b.createdAt) - new Date(a.periodEnd || a.createdAt))[0];
}

function siteName(site) {
  return [site?.cave, site?.zone, site?.pointCode].filter(Boolean).join(' / ') || '未知样点';
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateReadingPayload(db, payload) {
  if (!byId(db.sites, payload.siteId)) return '请选择有效样点';
  if (!byId(db.instruments, payload.instrumentId)) return '请选择有效仪器';
  if (!String(payload.operator || '').trim()) return '请填写操作员';
  if (!payload.periodStart || !payload.periodEnd) return '请填写测量时段';
  if (new Date(payload.periodEnd) < new Date(payload.periodStart)) return '时段结束不能早于开始';
  if (num(payload.radon) === null || num(payload.radon) < 0) return '氡浓度须为非负数值';
  if (num(payload.eec) === null || num(payload.eec) < 0) return '平衡当量浓度须为非负数值';
  return null;
}

function openClearance(db, site, reading) {
  const volume = num(site.chamberVolume);
  if (!volume || volume <= 0) return { error: `样点 ${siteName(site)} 缺少洞室容积，无法判定换气目标` };
  const now = new Date().toISOString();
  const clearance = {
    id: newId('clearance'),
    siteId: site.id,
    status: '待通风',
    targetVolume: Math.round(volume * AIR_EXCHANGE_RATIO * 100) / 100,
    exchangedVolume: 0,
    passes: 0,
    retests: [],
    triggerReadingId: reading.id,
    triggerOperator: reading.operator,
    ventilatedAt: null,
    openedAt: now,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
    history: []
  };
  pushHistory(clearance, '创建放行', `氡 ${reading.radon} Bq/m³、EEC ${reading.eec} 超限，换气目标 ${clearance.targetVolume} m³`);
  db.clearances.push(clearance);
  site.protectedStatus = '待通风';
  site.tourPermit = '暂停';
  pushHistory(site, '氡超限', '转入待通风，讲解许可暂停');
  touch(site);
  return { clearance };
}

// 登记一次氡巡查：校验仪器借用，随后按限值判定。
function registerReading(db, payload) {
  const error = validateReadingPayload(db, payload);
  if (error) return { error };
  const site = byId(db.sites, payload.siteId);
  const instrument = byId(db.instruments, payload.instrumentId);
  if (instrument.status === '借出' && instrument.siteId !== site.id) {
    return { error: `仪器未归还，不能借给别的样点（当前在 ${siteName(byId(db.sites, instrument.siteId))}）` };
  }
  const now = new Date().toISOString();
  const reading = {
    id: newId('radon'),
    siteId: site.id,
    instrumentId: instrument.id,
    operator: String(payload.operator).trim(),
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    radon: num(payload.radon),
    eec: num(payload.eec),
    note: payload.note || '',
    verdict: exceedsLimits(payload) ? '超限' : '合格',
    createdAt: now,
    updatedAt: now,
    history: []
  };
  pushHistory(reading, '创建', payload.note || `氡 ${reading.radon} Bq/m³，EEC ${reading.eec}`);
  db.radonReadings.push(reading);
  if (instrument.status !== '借出') {
    instrument.status = '借出';
    instrument.siteId = site.id;
    pushHistory(instrument, '借出', `借给 ${siteName(site)}`);
    touch(instrument);
  }
  let clearance = null;
  if (reading.verdict === '超限' && !openClearanceFor(db, site.id)) {
    const result = openClearance(db, site, reading);
    if (result.error) return result;
    clearance = result.clearance;
  }
  return { reading, clearance };
}

// 修订读数：未结束的放行失效，按新值重判，旧记录保留可查。
function reviseReading(db, id, payload) {
  const reading = byId(db.radonReadings, id);
  if (!reading) return { error: 'not found', status: 404 };
  const merged = { ...reading, ...payload };
  const error = validateReadingPayload(db, { ...merged, instrumentId: reading.instrumentId });
  if (error) return { error };
  const before = `氡 ${reading.radon}→${num(merged.radon)} Bq/m³，EEC ${reading.eec}→${num(merged.eec)}`;
  reading.operator = String(merged.operator).trim();
  reading.periodStart = merged.periodStart;
  reading.periodEnd = merged.periodEnd;
  reading.radon = num(merged.radon);
  reading.eec = num(merged.eec);
  reading.note = merged.note || '';
  reading.verdict = exceedsLimits(reading) ? '超限' : '合格';
  pushHistory(reading, '修订读数', before);
  touch(reading);
  const judged = rejudgeSite(db, reading.siteId, '修订读数，按新值重判');
  if (judged.error) return judged;
  return { reading };
}

// 重判某样点：作废未结束放行，再依据最新读数决定转入待通风或恢复常规观察。
function rejudgeSite(db, siteId, reason) {
  const site = byId(db.sites, siteId);
  if (!site) return { error: 'not found', status: 404 };
  const open = openClearanceFor(db, siteId);
  if (open) {
    open.status = '已失效';
    open.closedAt = new Date().toISOString();
    pushHistory(open, '放行失效', reason);
    touch(open);
  }
  const latest = latestReadingFor(db, siteId);
  if (latest && exceedsLimits(latest)) {
    const result = openClearance(db, site, latest);
    if (result.error) return result;
    return { clearance: result.clearance };
  }
  if (site.protectedStatus === '待通风') {
    site.protectedStatus = '常规观察';
    pushHistory(site, '恢复常规观察', reason);
  }
  if (site.tourPermit === '暂停') {
    site.tourPermit = '正常';
    if (site.protectedStatus !== '待通风') pushHistory(site, '讲解许可恢复', reason);
  }
  touch(site);
  return { clearance: null };
}

// 登记通风：累计换气量 = 风量 × 时长，达到洞室容积 3 倍后转入待复测。
function addVentilation(db, clearanceId, payload) {
  const clearance = byId(db.clearances, clearanceId);
  if (!clearance) return { error: 'not found', status: 404 };
  if (!OPEN_STATUSES.includes(clearance.status)) return { error: '放行已结束，不能登记通风' };
  const flowRate = num(payload.flowRate);
  const hours = num(payload.hours);
  if (!String(payload.operator || '').trim()) return { error: '请填写操作员' };
  if (!flowRate || flowRate <= 0) return { error: '风量须为正数' };
  if (!hours || hours <= 0) return { error: '时长须为正数' };
  const exchanged = Math.round(flowRate * hours * 100) / 100;
  const now = new Date().toISOString();
  const ventilation = {
    id: newId('vent'),
    clearanceId: clearance.id,
    siteId: clearance.siteId,
    operator: String(payload.operator).trim(),
    flowRate,
    hours,
    exchanged,
    note: payload.note || '',
    createdAt: now,
    updatedAt: now,
    history: []
  };
  pushHistory(ventilation, '创建', `风量 ${flowRate} m³/h × ${hours} h = ${exchanged} m³`);
  db.ventilations.push(ventilation);
  clearance.exchangedVolume = Math.round((clearance.exchangedVolume + exchanged) * 100) / 100;
  pushHistory(clearance, '登记通风', `+${exchanged} m³，累计 ${clearance.exchangedVolume}/${clearance.targetVolume} m³`);
  if (clearance.exchangedVolume >= clearance.targetVolume && !clearance.ventilatedAt) {
    clearance.ventilatedAt = now;
    clearance.status = '待复测';
    pushHistory(clearance, '换气达标', '累计换气量达到洞室容积 3 倍，可安排复测');
  }
  touch(clearance);
  return { ventilation, clearance };
}

// 登记复测：须换气达标，由另一位巡测员、与上次测量间隔 30 分钟；两次合格才放行。
function addRetest(db, clearanceId, payload) {
  const clearance = byId(db.clearances, clearanceId);
  if (!clearance) return { error: 'not found', status: 404 };
  if (clearance.status === '待通风') return { error: '换气量未达洞室容积 3 倍，暂不能复测' };
  if (clearance.status !== '待复测') return { error: '放行已结束，不能登记复测' };
  const operator = String(payload.operator || '').trim();
  if (!operator) return { error: '请填写复测巡测员' };
  const radon = num(payload.radon);
  const eec = num(payload.eec);
  if (radon === null || radon < 0) return { error: '氡浓度须为非负数值' };
  if (eec === null || eec < 0) return { error: '平衡当量浓度须为非负数值' };
  const at = payload.at ? new Date(payload.at) : new Date();
  if (Number.isNaN(at.getTime())) return { error: '复测时间无效' };
  const last = clearance.retests[clearance.retests.length - 1];
  const previousOperator = last ? last.operator : clearance.triggerOperator;
  if (operator === previousOperator) return { error: '复测须由另一位巡测员进行' };
  const reference = last ? new Date(last.at) : new Date(clearance.ventilatedAt);
  if (at.getTime() - reference.getTime() < RETEST_INTERVAL_MS) {
    return { error: '复测间隔须满 30 分钟' };
  }
  const pass = !exceedsLimits({ radon, eec });
  clearance.retests.push({ operator, at: at.toISOString(), radon, eec, pass, note: payload.note || '' });
  clearance.passes = pass ? (clearance.passes || 0) + 1 : 0;
  pushHistory(clearance, pass ? '复测合格' : '复测超限', `${operator}：氡 ${radon} Bq/m³，EEC ${eec}`);
  if (clearance.passes >= RETESTS_REQUIRED) {
    clearance.status = '已放行';
    clearance.closedAt = new Date().toISOString();
    pushHistory(clearance, '放行完成', '两次复测均低于限值，恢复常规观察');
    const site = byId(db.sites, clearance.siteId);
    if (site) {
      site.protectedStatus = '常规观察';
      site.tourPermit = '正常';
      pushHistory(site, '恢复常规观察', '氡放行完成，讲解许可恢复');
      touch(site);
    }
  }
  touch(clearance);
  return { clearance };
}

module.exports = {
  LIMITS,
  AIR_EXCHANGE_RATIO,
  RETESTS_REQUIRED,
  RETEST_INTERVAL_MS,
  exceedsLimits,
  openClearanceFor,
  registerReading,
  reviseReading,
  rejudgeSite,
  addVentilation,
  addRetest
};
