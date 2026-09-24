const express = require('express');
const path = require('path');

const app = express();
const config = require('./project.config');
const store = require('./src/store');
const radon = require('./src/radon');
const PORT = process.env.PORT || config.port || 3900;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { readDb, writeDb } = store;

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function respond(res, result, okStatus = 200) {
  if (result.error) return res.status(result.status || 409).json({ error: result.error });
  return res.status(okStatus).json(result);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// ---- 氡巡查与通风放行（判定逻辑在 src/radon.js，存档在 src/store.js）----

app.post('/api/radon/readings', async (req, res) => {
  const db = await readDb();
  const result = radon.registerReading(db, req.body || {});
  if (result.error) return respond(res, result);
  await writeDb(db);
  res.status(201).json(result);
});

app.patch('/api/radon/readings/:id', async (req, res) => {
  const db = await readDb();
  const result = radon.reviseReading(db, req.params.id, req.body || {});
  if (result.error) return respond(res, result);
  await writeDb(db);
  res.json(result);
});

app.post('/api/radon/clearances/:id/ventilations', async (req, res) => {
  const db = await readDb();
  const result = radon.addVentilation(db, req.params.id, req.body || {});
  if (result.error) return respond(res, result);
  await writeDb(db);
  res.status(201).json(result);
});

app.post('/api/radon/clearances/:id/retests', async (req, res) => {
  const db = await readDb();
  const result = radon.addRetest(db, req.params.id, req.body || {});
  if (result.error) return respond(res, result);
  await writeDb(db);
  res.status(201).json(result);
});

// ---- 通用集合接口 ----

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  // 氡读数、通风、放行必须走判定层接口，不能绕过规则直接建档
  if (['radonReadings', 'ventilations', 'clearances'].includes(collection)) {
    return res.status(409).json({ error: '请通过氡巡查与放行接口登记' });
  }
  const now = new Date().toISOString();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  // 氡读数修订必须走判定层：未结束放行失效并按新值重判
  if (collection === 'radonReadings') {
    const result = radon.reviseReading(db, id, req.body || {});
    if (result.error) return respond(res, result);
    await writeDb(db);
    return res.json(result);
  }
  const volumeChanged = collection === 'sites'
    && req.body.chamberVolume !== undefined
    && Number(req.body.chamberVolume) !== Number(item.chamberVolume);
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  // 修订洞室容积：未结束放行失效并按新容积重判
  if (volumeChanged) {
    item.history.unshift(stamp('修订容积', `洞室容积改为 ${req.body.chamberVolume} m³`));
    const judged = radon.rejudgeSite(db, id, '修订洞室容积，按新值重判');
    if (judged.error) return respond(res, judged);
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
