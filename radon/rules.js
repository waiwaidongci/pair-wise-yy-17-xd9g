// 氡巡查判定层：纯函数，只负责限值判断与放行进度计算，不触碰存储。
const LIMITS = {
  radon: 400, // 氡浓度限值，贝可/立方米
  eec: 120, // 平衡当量浓度限值
  airMultiple: 3, // 换气量须达洞室容积倍数
  retestGapMinutes: 30, // 复测间隔
  retestsRequired: 2 // 恢复常规观察所需连续合格复测次数
};

function exceedsLimits(entry) {
  return Number(entry.radon) > LIMITS.radon || Number(entry.eec) > LIMITS.eec;
}

function isActiveReading(reading) {
  return reading.status !== '已修订';
}

function isValidRecord(record) {
  return record.status !== '已失效';
}

function activeReadings(db, siteId) {
  return (db.radonReadings || []).filter((entry) => entry.siteId === siteId && isActiveReading(entry));
}

function latestReading(db, siteId) {
  return activeReadings(db, siteId)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

// 仪器被哪条未归还的有效巡查占用
function instrumentCheckout(db, instrumentId) {
  return (db.radonReadings || []).find(
    (entry) => entry.instrumentId === instrumentId && isActiveReading(entry) && !entry.returnedAt
  ) || null;
}

function requiredAir(site) {
  return LIMITS.airMultiple * Number(site.chamberVolume || 0);
}

// 本轮放行（clearanceEpoch 之后）仍有效的通风与复测记录
function clearanceRecords(db, site) {
  const epoch = site.clearanceEpoch ? new Date(site.clearanceEpoch).getTime() : null;
  const inRound = (record) => !epoch || new Date(record.createdAt || 0).getTime() >= epoch;
  const byTime = (a, b) => new Date(a.at || a.createdAt || 0) - new Date(b.at || b.createdAt || 0);
  const ventilations = (db.ventilations || [])
    .filter((entry) => entry.siteId === site.id && isValidRecord(entry) && inRound(entry))
    .sort(byTime);
  const retests = (db.retests || [])
    .filter((entry) => entry.siteId === site.id && isValidRecord(entry) && inRound(entry))
    .sort(byTime);
  return { ventilations, retests };
}

// 放行进度：换气量、连续合格复测次数、下次可复测时间
function clearanceState(db, site) {
  const required = requiredAir(site);
  const { ventilations, retests } = clearanceRecords(db, site);
  const ventilated = ventilations.reduce((sum, entry) => sum + Number(entry.airFlow || 0) * Number(entry.duration || 0), 0);
  const ventilationComplete = required > 0 && ventilated >= required;

  let consecutivePassed = 0;
  for (let index = retests.length - 1; index >= 0; index -= 1) {
    if (exceedsLimits(retests[index])) break;
    consecutivePassed += 1;
  }

  const lastVentilation = ventilations[ventilations.length - 1];
  const lastRetest = retests[retests.length - 1];
  const reference = lastRetest ? (lastRetest.at || lastRetest.createdAt) : (lastVentilation ? (lastVentilation.at || lastVentilation.createdAt) : null);
  const nextRetestAt = reference ? new Date(new Date(reference).getTime() + LIMITS.retestGapMinutes * 60000).toISOString() : null;

  return {
    requiredAir: required,
    ventilatedAir: ventilated,
    airRemaining: Math.max(0, required - ventilated),
    ventilationComplete,
    retestsPassed: consecutivePassed,
    retestsRemaining: Math.max(0, LIMITS.retestsRequired - consecutivePassed),
    nextRetestAt,
    triggerOperator: latestReading(db, site.id)?.operator || ''
  };
}

// 页面所需的全部判定结果
function overview(db) {
  const sites = (db.sites || []).map((site) => ({
    ...site,
    clearance: clearanceState(db, site),
    lastReading: latestReading(db, site.id)
  }));
  const instruments = (db.instruments || []).map((instrument) => {
    const checkout = instrumentCheckout(db, instrument.id);
    return {
      ...instrument,
      checkout: checkout
        ? { siteId: checkout.siteId, readingId: checkout.id, operator: checkout.operator, since: checkout.createdAt }
        : null
    };
  });
  const newest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  return {
    limits: LIMITS,
    sites,
    instruments,
    readings: [...(db.radonReadings || [])].sort(newest),
    ventilations: [...(db.ventilations || [])].sort(newest),
    retests: [...(db.retests || [])].sort(newest)
  };
}

module.exports = {
  LIMITS,
  exceedsLimits,
  latestReading,
  instrumentCheckout,
  requiredAir,
  clearanceState,
  overview
};
