// Lists pending refunds as ready-to-run quantus-cli commands.
//   node refunds.js            -> print commands
//   node refunds.js --done     -> mark all listed refunds as done (stop the indexer first)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const file = process.env.STATE_FILE || path.join(__dirname, "state.json");
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const pending = state.refunds.filter((r) => !r.done);
const fmt = (pl) => { const b = BigInt(pl); const w = b / 10n ** 12n, f = (b % 10n ** 12n).toString().padStart(12, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };
const wallet = process.env.TREASURY_WALLET_NAME || "treasury";

if (!pending.length) { console.log("No pending refunds."); process.exit(0); }
let total = 0n;
pending.forEach((r) => {
  total += BigInt(r.amount);
  console.log(`# block ${r.block} — ${r.reason}`);
  console.log(`quantus send --from ${wallet} --to ${r.to} --amount ${fmt(r.amount)} --finalized-tx`);
});
console.log(`\n${pending.length} refunds, total ${Number(total) / 1e12} QTC (plus fees)`);

if (process.argv.includes("--done")) {
  pending.forEach((r) => { r.done = true; });
  fs.writeFileSync(file, JSON.stringify(state));
  console.log("Marked as done.");
}
