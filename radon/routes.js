// 氡巡查 HTTP 路由：只做请求/响应转换，判定走 rules.js，落库走 store.js。
const express = require('express');
const rules = require('./rules');
const store = require('./store');

const router = express.Router();

function mutate(handler) {
  return async (req, res) => {
    const db = await store.readDb();
    const result = handler(db, req);
    if (result.error) return res.status(result.status || 409).json({ error: result.error });
    await store.writeDb(db);
    return res.status(result.created ? 201 : 200).json(result.item);
  };
}

router.get('/overview', async (req, res) => {
  const db = await store.readDb();
  res.json(rules.overview(db));
});

router.post('/readings', mutate((db, req) => store.addReading(db, req.body)));
router.post('/readings/:id/return', mutate((db, req) => store.returnInstrument(db, req.params.id)));
router.post('/readings/:id/revise', mutate((db, req) => store.reviseReading(db, req.params.id, req.body)));
router.post('/ventilations', mutate((db, req) => store.addVentilation(db, req.body)));
router.post('/retests', mutate((db, req) => store.addRetest(db, req.body)));
router.post('/sites/:id/volume', mutate((db, req) => store.updateVolume(db, req.params.id, req.body)));

module.exports = router;
