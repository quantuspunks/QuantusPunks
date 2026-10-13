// Pure mint / transfer rules for QuantusPunks. No network code here,
// so the rules can be tested offline (see test.js).
const crypto = require("crypto");

const UNIT = 10n ** 12n; // 1 QTC = 10^12 planck

function shuffledOrder(supply, seed) {
  // Deterministic Fisher-Yates using sha256(seed:counter) as randomness.
  const ids = Array.from({ length: supply }, (_, i) => i + 1);
  let counter = 0, pool = Buffer.alloc(0);
  function rand32() {
    if (pool.length < 4) {
      pool = Buffer.concat([pool, crypto.createHash("sha256").update(`${seed}:${counter++}`).digest()]);
    }
    const v = pool.readUInt32BE(0); pool = pool.subarray(4); return v;
  }
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rand32() % (i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

function newState(cfg) {
  return {
    version: 1,
    lastBlock: cfg.startBlock - 1,
    minted: 0,
    owners: {},        // id -> address
    mints: [],         // { block, event, from, paid, ids }
    transfers: [],     // { block, ext, from, to, ids }
    refunds: [],       // { block, event, to, amount, reason, done }
  };
}

// Called for each finalized Balances.Transfer event to the treasury.
function applyPayment(state, cfg, order, p) {
  const price = BigInt(cfg.pricePlanck);
  const paid = BigInt(p.amount);
  const remaining = cfg.supply - state.minted;
  let qty = Number(paid / price);
  let reason = null;
  if (qty > cfg.maxPerTx) { qty = cfg.maxPerTx; reason = "over max per transaction"; }
  if (qty > remaining) { qty = remaining; reason = remaining === 0 ? "sold out" : "partially sold out"; }
  const ids = [];
  for (let i = 0; i < qty; i++) {
    const id = order[state.minted];
    state.owners[id] = p.from;
    state.minted++;
    ids.push(id);
  }
  const change = paid - BigInt(qty) * price;
  if (qty > 0) state.mints.push({ block: p.block, event: p.event, from: p.from, paid: paid.toString(), ids });
  if (change > 0n) {
    state.refunds.push({
      block: p.block, event: p.event, to: p.from, amount: change.toString(),
      reason: reason || (qty === 0 ? "below mint price" : "not a multiple of mint price"), done: false,
    });
  }
  return ids;
}

// Remark format: qpunks:transfer:<id>[,<id>...]:<toAddress>
function parseRemark(text) {
  const m = /^qpunks:transfer:([0-9,]+):([1-9A-HJ-NP-Za-km-z]{40,60})$/.exec(String(text).trim());
  if (!m) return null;
  const ids = [...new Set(m[1].split(",").filter(Boolean).map(Number))];
  if (!ids.length || ids.length > 50 || ids.some((n) => !Number.isInteger(n) || n < 1)) return null;
  return { ids, to: m[2] };
}

// Applies a signed remark. normalize(addr) must return canonical SS58 or null.
function applyRemark(state, r, normalize) {
  const parsed = parseRemark(r.text);
  if (!parsed) return { ok: false, why: "not a qpunks remark" };
  const to = normalize(parsed.to);
  if (!to) return { ok: false, why: "bad destination address" };
  // all-or-nothing: signer must own every id
  if (parsed.ids.some((id) => state.owners[id] !== r.from)) return { ok: false, why: "signer does not own all ids" };
  parsed.ids.forEach((id) => { state.owners[id] = to; });
  state.transfers.push({ block: r.block, ext: r.ext, from: r.from, to, ids: parsed.ids });
  return { ok: true, ids: parsed.ids };
}

module.exports = { UNIT, shuffledOrder, newState, applyPayment, parseRemark, applyRemark };
