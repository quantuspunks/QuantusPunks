# QuantusPunks

10 000 punks pixel minted en QTC sur Quantus Network (L1 post-quantique, sans smart contracts).

- Supply : 10 000 · Prix : 0.01 QTC · Max 20 par transfert · Royalties 10 % (sur notre marketplace)
- Mint = transfert QTC vers l'adresse treasury → l'indexer attribue les punks au bloc finalisé
- Transferts de punks = remark on-chain `qpunks:transfer:<id>:<adresse>`

## Structure

```
site/      Site statique (déployer sur Vercel, comme ArcPunks)
  js/config.js   ← à modifier : api, treasury, date
  js/punks.js    rendu pixel des punks (navigateur + Node)
  data/traits.json  les 10 000 punks (hash de provenance dans rarity.json)
indexer/   Serveur Node : lit la chaîne, attribue les punks, sert l'API
scripts/generate.js  régénère la collection (node scripts/generate.js <seed>)
```

## Lancement (dans l'ordre)

1. **Treasury** : crée un wallet dédié dans Quantus Wallet ou `quantus wallet create --name treasury`. Copie l'adresse `qz…`.
2. **Indexer** (VPS, Railway ou Render) :
   ```
   cd indexer
   npm install
   cp .env.example .env     # remplis TREASURY, START_BLOCK, MINT_ORDER_SEED
   npm test                 # vérifie les règles de mint
   npm start                # API sur le port 8787
   ```
   - `START_BLOCK` = le bloc où le mint ouvre (les paiements avant sont ignorés).
   - `MINT_ORDER_SEED` = secret long. Au démarrage l'indexer affiche son sha256 : publie-le sur X avant le mint. Il est révélé automatiquement à la fin.
3. **Site** : mets l'URL de l'indexer (HTTPS) dans `site/js/config.js` → `api`, et l'adresse treasury → `treasury`. Déploie le dossier `site/` sur Vercel.
4. **Test réel** avant d'annoncer : envoie 0.01 QTC depuis un autre wallet, vérifie que l'indexer log le punk et que « My Punks » l'affiche.
5. **Remboursements** (montant en trop, après sold out) : `npm run refunds` affiche les commandes `quantus send` prêtes. Après envoi : arrête l'indexer, `node refunds.js --done`, relance.

## Limites à connaître

- Pas de smart contract sur Quantus : la propriété est calculée par l'indexer à partir des transferts on-chain (code ouvert, reproductible par n'importe qui).
- Les royalties 10 % ne s'appliquent que sur la marketplace QuantusPunks (à construire après sold out).
- Les transferts « wormhole » (privés) cachent l'expéditeur : ils ne peuvent pas être attribués.
- La lecture des remarks (transferts de punks) n'a pas encore été testée sur le RPC réel : le mint, lui, utilise seulement les événements `Balances.Transfer` (robuste). À tester avec un premier transfert après le mint.
