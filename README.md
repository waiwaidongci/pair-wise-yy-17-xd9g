# 钟乳石洞穴微环境巡测

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3912

数据保存在`data/db.json`，后续可以继续增量迭代。

## 氡巡查与通风放行

- `radon/rules.js`：判定层，限值（氡 400 Bq/m³、平衡当量浓度 120）、换气量（洞室容积 3 倍）、复测（另一位巡测员、隔 30 分钟、连续 2 次合格）均为纯函数。
- `radon/store.js`：存档层，负责读数登记/修订留档、仪器借还、通风与复测落库、放行失效与状态流转。
- `radon/routes.js` + `public/radon.js`：HTTP 接口与页面，挂在「氡巡查与通风」标签页，列表实时显示还差几次复测和换气量。
