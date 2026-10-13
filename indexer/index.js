// QuantusPunks indexer: watches finalized Quantus blocks, assigns punks to
// wallets that paid the treasury, tracks remark transfers, serves a JSON API.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { encodeAddress, decodeAddress } = require("@polkadot/util-crypto");
const { u8aToString } = require("@polkadot/util");
const core = require("./core");

const SS58 = 189;
const cfg = {
  rpc: process.env.RPC_URL || "wss://rpc.quantus.network",
  treasury: process.env.TREASURY,
  pricePlanck: process.env.PRICE_PLANCK || (core.UNIT / 100n).toString(), // 0.01 QTC
  supply: Number(process.env.SUPPLY || 10000),
  maxPerTx: Number(process.env.MAX_PER_TX || 20),
  startBlock: Number(process.env.START_BLOCK || 0),
  seed: process.env.MINT_ORDER_SEED,
  port: Number(process.env.PORT || 8787),
  stateFile: process.env.STATE_FILE || path.join(__dirname, "state.json"),
  royaltyBps: 1000,
};

function normalize(addr) {
  try { return encodeAddress(decodeAddress(addr), SS58); } catch { return null; }
}

if (!cfg.treasury || !normalize(cfg.treasury)) { console.error("Set TREASURY to your Quantus address (qz...) in .env"); process.exit(1); }
if (!cfg.seed || cfg.seed.length < 16) { console.error("Set MINT_ORDER_SEED (a long secret) in .env"); process.exit(1); }
if (!cfg.startBlock) { console.error("Set START_BLOCK (the block where mint opens) in .env"); process.exit(1); }
cfg.treasury = normalize(cfg.treasury);

const order = core.shuffledOrder(cfg.supply, cfg.seed);
const seedCommit = crypto.createHash("sha256").update(cfg.seed).digest("hex");
let state = fs.existsSync(cfg.stateFile) ? JSON.parse(fs.readFileSync(cfg.stateFile, "utf8")) : core.newState(cfg);
let finalizedHead = 0;

function save() {
  const tmp = cfg.stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, cfg.stateFile);
}

async function processBlock(api, n) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const at = await api.at(hash);
  const events = await at.query.system.events();

  // 1) payments (events only — robust even if extrinsic decoding changes)
  events.forEach((rec, i) => {
    const { event, phase } = rec;
    if (!phase.isApplyExtrinsic || event.section !== "balances" || event.method !== "Transfer") return;
    const [from, to, amount] = event.data;
    if (normalize(to.toString()) !== cfg.treasury) return;
    const sender = normalize(from.toString());
    if (!sender || sender === cfg.treasury) return;
    const ids = core.applyPayment(state, cfg, order, { block: n, event: i, from: sender, amount: amount.toString() });
    console.log(`#${n} payment ${Number(BigInt(amount.toString())) / 1e12} QTC from ${sender} -> punks [${ids.join(",")}]`);
  });

  // 2) remark transfers (needs extrinsic decoding; skipped safely if it fails)
  let block;
  try { block = await api.rpc.chain.getBlock(hash); } catch (e) { console.warn(`#${n} could not decode extrinsics: ${e.message}`); return; }
  block.block.extrinsics.forEach((ext, idx) => {
    try {
      const { section, method } = ext.method;
      if (section !== "system" || (method !== "remark" && method !== "remarkWithEvent") || !ext.isSigned) return;
      const ok = events.some((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.eqn(idx) && r.event.section === "system" && r.event.method === "ExtrinsicSuccess");
      if (!ok) return;
      const text = u8aToString(ext.method.args[0].toU8a(true));
      if (!text.startsWith("qpunks:")) return;
      const res = core.applyRemark(state, { block: n, ext: idx, from: normalize(ext.signer.toString()), text }, normalize);
      console.log(`#${n} remark ${text} -> ${res.ok ? "ok" : res.why}`);
    } catch (e) { console.warn(`#${n} ext ${idx} skipped: ${e.message}`); }
  });
}

async function catchUp(api) {
  while (state.lastBlock < finalizedHead) {
    const n = state.lastBlock + 1;
    await processBlock(api, n);
    state.lastBlock = n;
    if (n % 50 === 0 || n === finalizedHead) save();
  }
}

// ---------- HTTP API ----------
function stats() {
  return {
    name: "QuantusPunks", supply: cfg.supply, minted: state.minted, pricePlanck: cfg.pricePlanck,
    priceQTC: Number(BigInt(cfg.pricePlanck)) / 1e12, maxPerTx: cfg.maxPerTx, treasury: cfg.treasury,
    royaltyBps: cfg.royaltyBps, lastBlock: state.lastBlock, finalizedHead, startBlock: cfg.startBlock,
    seedCommit, seedReveal: state.minted >= cfg.supply ? cfg.seed : null,
  };
}
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/api/stats") return send(res, 200, stats());
  if (p === "/api/recent") return send(res, 200, state.mints.slice(-30).reverse());
  if (p === "/api/owners") return send(res, 200, state.owners);
  let m;
  if ((m = /^\/api\/owner\/([^/]+)$/.exec(p))) {
    const a = normalize(decodeURIComponent(m[1]));
    if (!a) return send(res, 400, { error: "invalid Quantus address" });
    const ids = Object.keys(state.owners).filter((id) => state.owners[id] === a).map(Number).sort((x, y) => x - y);
    const refunds = state.refunds.filter((r) => r.to === a);
    return send(res, 200, { address: a, ids, refunds });
  }
  if ((m = /^\/api\/punk\/(\d+)$/.exec(p))) {
    const id = Number(m[1]);
    if (id < 1 || id > cfg.supply) return send(res, 404, { error: "no such punk" });
    return send(res, 200, { id, owner: state.owners[id] || null, history: state.transfers.filter((t) => t.ids.includes(id)) });
  }
  send(res, 404, { error: "not found" });
}).listen(cfg.port, () => console.log(`API on :${cfg.port}`));

// ---------- main loop ----------
(async () => {
  console.log(`Treasury ${cfg.treasury} | price ${cfg.pricePlanck} planck | seed commit ${seedCommit}`);
  const api = await ApiPromise.create({ provider: new WsProvider(cfg.rpc) });
  let busy = false;
  await api.rpc.chain.subscribeFinalizedHeads(async (h) => {
    finalizedHead = h.number.toNumber();
    if (busy) return;
    busy = true;
    try { await catchUp(api); } catch (e) { console.error("catch-up error:", e.message); }
    busy = false;
  });
})().catch((e) => { console.error(e); process.exit(1); });

process.on("SIGINT", () => { save(); process.exit(0); });
