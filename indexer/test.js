// Offline tests for the mint/transfer rules: node test.js
const assert = require("assert");
const crypto = require("crypto");
const { encodeAddress, decodeAddress } = require("@polkadot/util-crypto");
const core = require("./core");

const addr = () => encodeAddress(crypto.randomBytes(32), 189);
const normalize = (a) => { try { return encodeAddress(decodeAddress(a), 189); } catch { return null; } };
const P = 10_000_000_000n; // 0.01 QTC
const cfg = { supply: 25, maxPerTx: 20, pricePlanck: P.toString(), startBlock: 100 };

// order is a permutation of 1..supply and deterministic
const order = core.shuffledOrder(cfg.supply, "secret-seed-123456");
assert.deepStrictEqual([...order].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
assert.deepStrictEqual(order, core.shuffledOrder(cfg.supply, "secret-seed-123456"));
assert.notDeepStrictEqual(order, core.shuffledOrder(cfg.supply, "other-seed-abcdef"));
const big = core.shuffledOrder(10000, "x".repeat(20));
assert.strictEqual(new Set(big).size, 10000);

const s = core.newState(cfg);
const A = addr(), B = addr(), C = addr();

// exact 3 punks
let ids = core.applyPayment(s, cfg, order, { block: 101, event: 2, from: A, amount: (3n * P).toString() });
assert.strictEqual(ids.length, 3); assert.strictEqual(s.minted, 3); assert.strictEqual(s.refunds.length, 0);

// 2.5 punks -> 2 punks + refund 0.005
ids = core.applyPayment(s, cfg, order, { block: 102, event: 1, from: B, amount: (25n * P / 10n).toString() });
assert.strictEqual(ids.length, 2); assert.strictEqual(s.refunds[0].amount, (P / 2n).toString());

// below price -> full refund
ids = core.applyPayment(s, cfg, order, { block: 103, event: 1, from: C, amount: "5" });
assert.strictEqual(ids.length, 0); assert.strictEqual(s.refunds[1].reason, "below mint price");

// over max per tx -> 20 + refund of extra 5
ids = core.applyPayment(s, cfg, order, { block: 104, event: 1, from: C, amount: (25n * P).toString() });
assert.strictEqual(ids.length, 20); assert.strictEqual(s.minted, 25);
assert.strictEqual(s.refunds[2].amount, (5n * P).toString());

// sold out -> full refund
ids = core.applyPayment(s, cfg, order, { block: 105, event: 1, from: A, amount: P.toString() });
assert.strictEqual(ids.length, 0); assert.strictEqual(s.refunds[3].reason, "sold out");
assert.strictEqual(Object.keys(s.owners).length, 25);

// remark transfer
const aIds = Object.keys(s.owners).filter((k) => s.owners[k] === A).map(Number);
let r = core.applyRemark(s, { block: 106, ext: 1, from: A, text: `qpunks:transfer:${aIds[0]}:${B}` }, normalize);
assert.ok(r.ok); assert.strictEqual(s.owners[aIds[0]], B);
// cannot move someone else's punk
r = core.applyRemark(s, { block: 107, ext: 1, from: A, text: `qpunks:transfer:${aIds[0]}:${C}` }, normalize);
assert.ok(!r.ok);
// all-or-nothing batch
r = core.applyRemark(s, { block: 108, ext: 1, from: A, text: `qpunks:transfer:${aIds[1]},${aIds[0]}:${C}` }, normalize);
assert.ok(!r.ok); assert.strictEqual(s.owners[aIds[1]], A);
// garbage
assert.strictEqual(core.parseRemark("hello"), null);
assert.strictEqual(core.parseRemark("qpunks:transfer:0:" + B), null);

console.log("All indexer tests passed ✔");
