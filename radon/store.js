// 氡巡查存档层：负责 db.json 读写与各类登记/修订落库，判定规则全部来自 rules.js。
const fs = require('fs/promises');
const path = require('path');
const rules = require('./rules');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return { at: new Date().toISOString(), action, note: note || '' };
}

function touch(item, action, note) {
  item.updatedAt = new Date().toISOString();
  item.history = item.history || [];
  item.history.unshift(stamp(action, note));
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function fail(message, status = 409) {
  return { error: message, status };
}

function findSite(db, siteId) {
  return (db.sites || []).find((entry) => entry.id === siteId) || null;
}

// 超限则转入待通风并暂停讲解许可（只升级，不自动恢复）
function escalateIfExceeded(site, reading) {
  if (!rules.exceedsLimits(reading) || site.radonStatus === '待通风') return;
  site.radonStatus = '待通风';
  site.permitStatus = '许可暂停';
  site.clearanceEpoch = new Date().toISOString();
  touch(site, '转入待通风', `氡 ${reading.radon} Bq/m³ / 等效 ${reading.eec} 超限，讲解许可暂停`);
}

// 修订后按最新有效读数重判：超限保持/转入待通风，低于限值直接恢复
function rejudgeSite(db, site, note) {
  const reading = rules.latestReading(db, site.id);
  const exceeded = reading && rules.exceedsLimits(reading);
  if (exceeded) {
    escalateIfExceeded(site, reading);
  } else if (site.radonStatus === '待通风') {
    site.radonStatus = '常规观察';
    site.permitStatus = '许可正常';
    site.clearanceEpoch = null;
    touch(site, '恢复常规观察', note || '按修订后读数重判，已低于限值');
  }
}

// 让本轮未结束放行中的通风与复测记录失效（保留可查）
function voidOpenClearance(db, site, reason) {
  const epoch = site.clearanceEpoch ? new Date(site.clearanceEpoch).getTime() : null;
  const inRound = (record) => !epoch || new Date(record.createdAt || 0).getTime() >= epoch;
  let voided = 0;
  for (const collection of ['ventilations', 'retests']) {
    for (const record of db[collection] || []) {
      if (record.siteId === site.id && record.status !== '已失效' && inRound(record)) {
        record.status = '已失效';
        touch(record, '放行失效', reason);
        voided += 1;
      }
    }
  }
  return voided;
}

// 登记氡巡查：仪器未归还时不能借给别的样点
function addReading(db, data) {
  const site = findSite(db, data.siteId);
  if (!site) return fail('样点不存在', 404);
  if (!(db.instruments || []).some((entry) => entry.id === data.instrumentId)) return fail('仪器不存在', 404);
  const checkout = rules.instrumentCheckout(db, data.instrumentId);
  if (checkout && checkout.siteId !== data.siteId) {
    return fail('仪器尚未归还，不能借给别的样点');
  }
  const reading = {
    id: newId('radon'),
    siteId: data.siteId,
    instrumentId: data.instrumentId,
    periodStart: data.periodStart || '',
    periodEnd: data.periodEnd || '',
    radon: Number(data.radon || 0),
    eec: Number(data.eec || 0),
    operator: data.operator || '',
    status: '有效',
    returnedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [stamp('创建', data.note || '登记氡巡查')]
  };
  db.radonReadings = db.radonReadings || [];
  db.radonReadings.push(reading);
  escalateIfExceeded(site, reading);
  return { item: reading, created: true };
}

// 仪器归还
function returnInstrument(db, readingId) {
  const reading = (db.radonReadings || []).find((entry) => entry.id === readingId);
  if (!reading) return fail('巡查记录不存在', 404);
  if (reading.returnedAt) return fail('仪器已归还');
  reading.returnedAt = new Date().toISOString();
  touch(reading, '仪器归还', '');
  return { item: reading };
}

// 修订读数：旧记录标记“已修订”留档，未结束放行失效，按新值重判
function reviseReading(db, readingId, data) {
  const old = (db.radonReadings || []).find((entry) => entry.id === readingId);
  if (!old) return fail('巡查记录不存在', 404);
  if (old.status === '已修订') return fail('该记录已被修订，请基于最新读数修订');
  const site = findSite(db, old.siteId);
  const next = {
    ...old,
    id: newId('radon'),
    radon: Number(data.radon || 0),
    eec: Number(data.eec || 0),
    status: '有效',
    revisionOf: old.id,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [stamp('修订', data.note || `修订自 ${old.id}`)]
  };
  old.status = '已修订';
  old.supersededBy = next.id;
  touch(old, '被修订', data.note || '读数被修订，旧记录留档');
  db.radonReadings.push(next);
  if (site) {
    voidOpenClearance(db, site, '读数修订，未结束放行失效');
    rejudgeSite(db, site);
  }
  return { item: next, created: true };
}

// 登记通风：风量 × 时长计入换气量
function addVentilation(db, data) {
  const site = findSite(db, data.siteId);
  if (!site) return fail('样点不存在', 404);
  if (site.radonStatus !== '待通风') return fail('样点未处于待通风，无需登记通风');
  const record = {
    id: newId('vent'),
    siteId: data.siteId,
    airFlow: Number(data.airFlow || 0),
    duration: Number(data.duration || 0),
    exchange: Number(data.airFlow || 0) * Number(data.duration || 0),
    at: data.at || new Date().toISOString(),
    operator: data.operator || '',
    status: '有效',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [stamp('创建', '登记通风')]
  };
  db.ventilations = db.ventilations || [];
  db.ventilations.push(record);
  return { item: record, created: true };
}

// 登记复测：换气量达标后，由另一位巡测员隔 30 分钟复测，两次合格才恢复
function addRetest(db, data) {
  const site = findSite(db, data.siteId);
  if (!site) return fail('样点不存在', 404);
  if (site.radonStatus !== '待通风') return fail('样点未处于待通风');
  const state = rules.clearanceState(db, site);
  if (!state.ventilationComplete) {
    return fail(`换气量未达洞室容积 ${rules.LIMITS.airMultiple} 倍（${state.ventilatedAir}/${state.requiredAir} m³），不能复测`);
  }
  if (state.triggerOperator && data.surveyor === state.triggerOperator) {
    return fail('须由另一位巡测员复测');
  }
  const at = data.at ? new Date(data.at) : new Date();
  if (state.nextRetestAt && at.getTime() < new Date(state.nextRetestAt).getTime()) {
    return fail(`复测需间隔 ${rules.LIMITS.retestGapMinutes} 分钟，最早可于 ${new Date(state.nextRetestAt).toLocaleString('zh-CN', { hour12: false })} 复测`);
  }
  const record = {
    id: newId('retest'),
    siteId: data.siteId,
    surveyor: data.surveyor || '',
    radon: Number(data.radon || 0),
    eec: Number(data.eec || 0),
    at: at.toISOString(),
    passed: !rules.exceedsLimits({ radon: data.radon, eec: data.eec }),
    status: '有效',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [stamp('创建', '登记复测')]
  };
  db.retests = db.retests || [];
  db.retests.push(record);
  const after = rules.clearanceState(db, site);
  if (after.retestsPassed >= rules.LIMITS.retestsRequired) {
    site.radonStatus = '常规观察';
    site.permitStatus = '许可正常';
    site.clearanceEpoch = null;
    touch(site, '恢复常规观察', `连续 ${rules.LIMITS.retestsRequired} 次复测低于限值，讲解许可恢复`);
  }
  return { item: record, created: true };
}

// 修订洞室容积：未结束放行失效，按新容积重判
function updateVolume(db, siteId, data) {
  const site = findSite(db, siteId);
  if (!site) return fail('样点不存在', 404);
  site.chamberVolume = Number(data.chamberVolume || 0);
  touch(site, '修订容积', `${site.chamberVolume} m³`);
  voidOpenClearance(db, site, '容积修订，未结束放行失效');
  rejudgeSite(db, site, '容积修订后重判');
  return { item: site };
}

module.exports = {
  readDb,
  writeDb,
  stamp,
  addReading,
  returnInstrument,
  reviseReading,
  addVentilation,
  addRetest,
  updateVolume
};
