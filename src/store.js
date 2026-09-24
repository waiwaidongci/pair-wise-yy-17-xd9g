// 存档层：负责 db.json 的读写与通用记录工具，不含任何业务判定。
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function pushHistory(item, action, note) {
  item.history = item.history || [];
  item.history.unshift(stamp(action, note));
}

function touch(item) {
  item.updatedAt = new Date().toISOString();
}

function byId(collection, id) {
  return (collection || []).find((entry) => entry.id === id);
}

module.exports = { readDb, writeDb, newId, stamp, pushHistory, touch, byId };
