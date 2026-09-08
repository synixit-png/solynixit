const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const requestLog = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  if (requestLog.size > 5000) requestLog.clear();
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Every analysis must hit the upstream APIs fresh — never serve a stale
  // cached result for a live risk score. Nothing here caches internally, but
  // this explicitly stops Vercel's edge/CDN from doing it on our behalf.
  res.setHeader('Cache-Control', 'no-store');
  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Trop de requêtes. Réessaie dans une minute.' });
  }
  const { address } = req.query;
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Adresse invalide.' });
  }
  try {
    const [tokenData, securityData, marketData, insidersData] = await Promise.allSettled([
      fetchTokenOverview(address),
      fetchRugCheck(address),
      fetchDexScreener(address),
      fetchInsiders(address),
    ]);
    const token = tokenData.status === 'fulfilled' ? tokenData.value : null;
    const security = securityData.status === 'fulfilled' ? securityData.value : null;
    const dex = marketData.status === 'fulfilled' ? marketData.value : null;
    const insiders = insidersData.status === 'fulfilled' ? insidersData.value : null;
    if (!token && !security && !dex) {
      return res.status(404).json({ error: 'Token introuvable — vérifie l\'adresse ou réessaie plus tard.' });
    }
    return res.status(200).json(buildAnalysis(address, token, security, dex, insiders));
  } catch (err) {
    return res.status(500).json({ error: "Erreur lors de l'analyse. Réessaie." });
  }
}

async function fetchTokenOverview(address) {
  const r = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${address}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    cache: 'no-store'
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.data || null;
}

// RugCheck.xyz — free public Solana token security report, no API key
// required for single-token lookups. Used instead of Birdeye's
// token_security endpoint, which requires a paid plan tier we don't have.
async function fetchRugCheck(address) {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report`, { cache: 'no-store' });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('RugCheck error', r.status, body.slice(0, 300));
      return null;
    }
    const j = await r.json();
    return j || null;
  } catch (e) {
    console.error('RugCheck exception', e);
    return null;
  }
}

// RugCheck's insider/bundled-wallet graph. Real-world integrations disagree
// on the exact response shape (seen: {insiders:[...]}, {nodes:[...],edges:[...]},
// or a bare array), so this is parsed defensively in buildAnalysis — an
// unrecognized shape just falls back to "not tracked", never a wrong count.
async function fetchInsiders(address) {
  try {
    const r = await fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/insiders/graph`, { cache: 'no-store' });
    if (!r.ok) {
      console.error('RugCheck insiders error', r.status);
      return null;
    }
    const j = await r.json();
    return j || null;
  } catch (e) {
    console.error('RugCheck insiders exception', e);
    return null;
  }
}

async function fetchDexScreener(address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  return j.pairs?.[0] || null;
}

// The insiders/graph endpoint's shape isn't consistent across known
// integrations, so we try the documented variants in order and stop at the
// first one that matches — never guess a number from an unrecognized shape.
function countLinkedWallets(insiders) {
  if (!insiders) return null;
  if (Array.isArray(insiders)) return insiders.length;
  if (Array.isArray(insiders.insiders)) return insiders.insiders.length;
  if (Array.isArray(insiders.nodes)) return Math.max(0, insiders.nodes.length - 1);
  return null;
}

function buildAnalysis(address, token, security, dex, insiders) {
  const name = token?.name || dex?.baseToken?.name || null;
  const symbol = token?.symbol || dex?.baseToken?.symbol || null;
  const holders = token?.holder || 0;
  const liquidityUsd = dex?.liquidity?.usd || token?.liquidity || 0;
  const volume24h = dex?.volume?.h24 || token?.v24hUSD || 0;
  const mcap = token?.mc || dex?.fdv || 0;

  const securityAvailable = security !== null;
  const mintRevoked = securityAvailable ? (security.mintAuthority === null || security.mintAuthority === undefined || security.mintAuthority === '') : null;
  const freezeRevoked = securityAvailable ? (security.freezeAuthority === null || security.freezeAuthority === undefined || security.freezeAuthority === '') : null;
  const creatorAddress = securityAvailable ? (security.creator || null) : null;
  const prevRugs = securityAvailable ? (security.rugged ? 1 : 0) : null;
  const top10pct = securityAvailable && Array.isArray(security.topHolders)
    ? Math.round(security.topHolders.slice(0, 10).reduce((sum, h) => sum + (Number(h?.pct) || 0), 0))
    : null;
  const primaryMarket = securityAvailable && Array.isArray(security.markets) ? security.markets[0] : null;
  const lpLockedPctRaw = primaryMarket?.lp?.lpLockedPct;
  const lpLockedPct = typeof lpLockedPctRaw === 'number' ? Math.round(lpLockedPctRaw) : null;
  // A lock percentage is meaningless if there's nothing left to lock — 100%
  // of a $7 pool is still $7. Treat a near-empty pool as unsafe regardless of
  // the lock %, so a drained liquidity pool can't hide behind "100% locked".
  const liquidityTooThin = liquidityUsd > 0 && liquidityUsd < 2000;
  const liquidityLocked = lpLockedPct === null ? null : liquidityTooThin ? false : lpLockedPct >= 50;
  const linkedWallets = countLinkedWallets(insiders);
  // "% already sold" isn't exposed by RugCheck's report, but the more
  // actionable question — can the dev still crash the price by dumping — is
  // answerable from data we already have: is the creator's own wallet among
  // the top holders, and how much do they currently hold? Locked liquidity
  // only stops an LP pull; it does nothing to stop this.
  const creatorHolder = securityAvailable && Array.isArray(security.topHolders) && creatorAddress
    ? security.topHolders.find(h => h && (h.address === creatorAddress || h.owner === creatorAddress))
    : null;
  const creatorHoldingPct = creatorHolder ? Math.round(Number(creatorHolder.pct) || 0) : null;
  const devSoldPct = null;

  // Locked liquidity and revoked authorities describe what CAN'T happen
  // structurally — they say nothing about whether a dump has already
  // happened. A handful of concentrated holders can crash the price by
  // selling directly, no LP pull required. DexScreener's priceChange is
  // real, already-occurred market behavior, not a structural prediction.
  const priceChange1h = typeof dex?.priceChange?.h1 === 'number' ? dex.priceChange.h1 : null;
  const priceCrashed = priceChange1h !== null ? priceChange1h <= -50 : null;

  const createdAt = token?.createdAt || dex?.pairCreatedAt;
  const ageMs = createdAt ? Date.now() - createdAt : null;
  const ageHours = ageMs ? Math.floor(ageMs / 3600000) : null;
  const ageLabel = ageHours === null ? 'Inconnu' : ageHours < 24 ? ageHours + 'h' : ageHours < 720 ? Math.floor(ageHours / 24) + 'j' : Math.floor(ageHours / 720) + ' mois';

  const fetchFailedMsg = 'Donnée de sécurité indisponible — impossible de vérifier ce signal.';
  const notTrackedMsg = "Ce signal n'est pas encore pris en charge par notre analyse actuelle.";

  // Holder-count bar scales with token age: 1000+ holders after a few hours is
  // strong traction, the same count after months would be stagnant. Avoids
  // flagging young, fast-growing tokens as mediocre just because they haven't
  // had time to accumulate the holder count an older token would need.
  const holderBar = ageHours === null ? { ok: 3000, warn: 500 }
    : ageHours < 24 ? { ok: 500, warn: 100 }
    : ageHours < 168 ? { ok: 1500, warn: 300 }
    : { ok: 3000, warn: 500 };
  const holderStatus = holders > holderBar.ok ? 'ok' : holders > holderBar.warn ? 'warn' : 'bad';
  // A handful of holders isn't "risky distribution" on a sliding scale — it's
  // not a real market yet. Buying means you'd likely be the first and only
  // real counterparty. This is a verifiable current fact, not a prediction,
  // so it gets the same hard cap treatment as an already-confirmed crash.
  const noRealMarket = holders > 0 && holders <= 3;
  const holderAgeNote = ageHours === null ? '' : ' (token âgé de ' + ageLabel + ')';

  // "No rugs found" is only meaningful if the wallet has existed long enough
  // to have had a realistic chance to rug something. A 0-hour-old wallet
  // trivially has zero rug history — that's an empty track record, not a
  // clean one, and must not score as if it were the same thing.
  const creatorTooYoung = ageHours !== null && ageHours < 24;
  const creatorKnown = prevRugs !== null;
  const creatorStatus = !creatorKnown ? 'warn' : prevRugs > 0 ? 'bad' : creatorTooYoung ? 'warn' : 'ok';
  const creatorBadText = !creatorKnown ? fetchFailedMsg
    : prevRugs > 0 ? prevRugs + ' rug pull(s) antérieur(s) sur ce wallet.'
    : "Wallet trop récent (" + ageLabel + ") pour avoir un historique significatif — l'absence de rug n'est pas encore prouvée, juste pas encore démentie.";

  // `known` marks whether we actually have data for this signal, separate from
  // `status`. A signal can be 'warn' for two very different reasons: genuinely
  // ambiguous data we DO have (e.g. top10pct at 32%, known=true) vs data we
  // simply don't have at all (known=false). Only known signals count toward
  // the score and toward confidence — an unknown never buys partial credit.
  const signals = [
    { name: 'Liquidité lockée', known: liquidityLocked !== null, status: liquidityLocked === null ? 'warn' : liquidityLocked ? 'ok' : 'bad', good: 'Liquidité lockée à ' + lpLockedPct + '% — le dev ne peut pas retirer les fonds facilement.', bad: liquidityLocked === null ? notTrackedMsg : liquidityTooThin ? 'Lockée à ' + lpLockedPct + '%, mais la pool ne contient que $' + Math.round(liquidityUsd).toLocaleString('fr') + ' — verrouiller un montant quasi nul ne protège de rien.' : 'Liquidité lockée à seulement ' + lpLockedPct + '% — rug pull possible à tout moment.', impact: 'Si le dev retire la liquidité, le token vaut 0 en secondes.', weight: 20, eliminatory: true },
    { name: 'Mint authority révoquée', known: mintRevoked !== null, status: mintRevoked === null ? 'warn' : mintRevoked ? 'ok' : 'bad', good: 'Impossible de créer de nouveaux tokens — supply fixe.', bad: mintRevoked === null ? fetchFailedMsg : "Mint authority active — le dev peut créer des tokens à l'infini.", impact: 'Création illimitée = dilution et destruction de valeur.', weight: 18, eliminatory: true },
    { name: 'Freeze authority révoquée', known: freezeRevoked !== null, status: freezeRevoked === null ? 'warn' : freezeRevoked ? 'ok' : 'bad', good: 'Personne ne peut bloquer tes tokens.', bad: freezeRevoked === null ? fetchFailedMsg : 'Freeze authority active — le dev peut geler ton wallet.', impact: 'Tu pourrais être bloqué et incapable de vendre.', weight: 12, eliminatory: false },
    { name: 'Distribution des holders', known: true, status: holderStatus, good: holders.toLocaleString('fr') + ' holders' + holderAgeNote + ' — bonne distribution pour son âge.', bad: holders.toLocaleString('fr') + ' holders seulement' + holderAgeNote + ' — manipulation facile.', impact: 'Peu de holders = prix contrôlé par quelques wallets.', weight: 12, eliminatory: false },
    { name: 'Concentration top 10 wallets', known: top10pct !== null, status: top10pct === null ? 'warn' : top10pct < 25 ? 'ok' : top10pct < 50 ? 'warn' : 'bad', good: 'Top 10 = ' + top10pct + '% — bien distribué.', bad: top10pct === null ? 'Données non disponibles.' : 'Top 10 = ' + top10pct + '% — dump massif possible.', impact: "Si ces wallets vendent ensemble, le prix s'effondre.", weight: 14, eliminatory: false },
    { name: 'Chute de prix récente', known: priceChange1h !== null, status: priceChange1h === null ? 'warn' : priceChange1h <= -50 ? 'bad' : priceChange1h <= -20 ? 'warn' : 'ok', good: 'Prix stable sur la dernière heure (' + (priceChange1h >= 0 ? '+' : '') + priceChange1h + '%) — pas de dump détecté.', bad: priceChange1h === null ? notTrackedMsg : 'Prix en chute de ' + Math.abs(priceChange1h) + '% sur la dernière heure — un dump est probablement déjà en cours.', impact: "La liquidité lockée n'empêche pas les holders de vendre directement leurs tokens.", weight: 16, eliminatory: true },
    { name: 'Wallet du créateur', known: creatorHoldingPct !== null, status: creatorHoldingPct === null ? 'warn' : creatorHoldingPct < 3 ? 'ok' : creatorHoldingPct < 10 ? 'warn' : 'bad', good: 'Le créateur détient ' + creatorHoldingPct + '% du supply — dump massif peu probable.', bad: creatorHoldingPct === null ? "Pas dans le top holders — impossible de vérifier ce qu'il détient encore." : 'Le créateur détient encore ' + creatorHoldingPct + "% du supply — il peut faire chuter le prix en vendant, même si la liquidité est lockée.", impact: 'La liquidité lockée empêche un retrait de pool, pas un dump direct des tokens du créateur.', weight: 12, eliminatory: true },
    { name: 'Historique du créateur', known: creatorKnown, status: creatorStatus, good: 'Aucun rug pull antérieur détecté.', bad: creatorBadText, impact: 'Un serial rugger a 90% de chances de recommencer.', weight: 8, eliminatory: true },
    { name: 'Coordination de wallets', known: linkedWallets !== null, status: linkedWallets === null ? 'warn' : linkedWallets > 3 ? 'bad' : linkedWallets > 1 ? 'warn' : 'ok', good: 'Pas de coordination détectée.', bad: linkedWallets === null ? notTrackedMsg : linkedWallets + ' wallets liés — pump & dump possible.', impact: 'Wallets coordonnés = manipulation organisée.', weight: 4, eliminatory: false },
  ];

  // Score is renormalized over KNOWN signals only, so missing data is simply
  // excluded rather than silently earning the 40% "ambiguous" credit that a
  // genuinely-known-but-mixed signal (e.g. top10pct at 32%) deserves.
  // Confidence tracks, separately, how much of the full picture we actually
  // have — a high score built on low confidence is not the same as a high
  // score built on solid data, and the UI needs both.
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const knownWeight = signals.filter(s => s.known).reduce((sum, s) => sum + s.weight, 0);
  const dataConfidence = totalWeight > 0 ? (knownWeight / totalWeight) : 0;
  // A brand-new token hasn't been tested by real market behavior yet — that's
  // a confidence problem, not a verdict problem. Suppressing the SCORE itself
  // for every young token defeats the tool's actual purpose (telling a good
  // new project apart from a bad one) by flattening both into "Danger"
  // regardless of how clean or dirty their real signals are. Instead, age
  // discounts CONFIDENCE: a young token with genuinely good signals can still
  // score high, but the confidence attached to that score is honestly lower
  // until it's survived some real time in the market.
  const ageConfidenceFactor = ageHours === null ? 1 : ageHours < 1 ? 0.5 : ageHours < 24 ? 0.8 : 1;
  const confidence = Math.round(dataConfidence * ageConfidenceFactor * 100);

  let scoreSum = 0, hasEliminatory = false;
  signals.forEach(s => {
    if (!s.known) return;
    if (s.status === 'ok') scoreSum += s.weight;
    else if (s.status === 'warn') scoreSum += s.weight * 0.4;
    else if (s.eliminatory) hasEliminatory = true;
  });
  let score = knownWeight > 0 ? Math.round((scoreSum / knownWeight) * 100) : 0;
  if (hasEliminatory) score = Math.min(score, 35);
  // A confirmed ongoing crash outweighs every structural check — this isn't a
  // risk prediction anymore, it's an already-observed outcome. A locked LP
  // and revoked authorities don't matter if the price already collapsed, and
  // a near-empty pool (however "locked") means the money is already gone.
  const crashCap = (priceCrashed || liquidityTooThin || noRealMarket) ? 10 : null;
  const crashCapped = crashCap !== null && score > crashCap;
  if (crashCap !== null) score = Math.min(score, crashCap);
  score = Math.round(Math.max(0, Math.min(100, score)));

  let reputationScore = 100;
  if (prevRugs !== null && prevRugs > 0) reputationScore -= 60;
  if (devSoldPct !== null && devSoldPct > 50) reputationScore -= 20;
  if (linkedWallets !== null && linkedWallets > 3) reputationScore -= 15;
  if (ageHours !== null && ageHours < 48) reputationScore -= 10;
  reputationScore = Math.max(0, reputationScore);
  // A high reputationScore built on very little real data is not "trustworthy"
  // — it just means nothing bad was found yet, which is not the same thing.
  // Below 50% confidence, say so explicitly instead of vouching for the wallet.
  const reputationLabel = confidence < 50 ? 'Données insuffisantes'
    : reputationScore >= 70 ? 'Fiable' : reputationScore >= 40 ? 'Suspect' : 'Dangereux';

  return {
    address, name, symbol, score, confidence, scoreCapped: hasEliminatory, ageDiscounted: ageConfidenceFactor < 1, crashCapped, ageHours, priceChange1h, signals,
    creator: { address: creatorAddress, prevRugs, walletAge: ageLabel, devSoldPct, creatorHoldingPct, linkedWallets, reputationScore, reputationLabel },
    market: { holders, top10pct, liquidityUsd: Math.round(liquidityUsd), volume24h: Math.round(volume24h), mcap: Math.round(mcap), age: ageLabel, liquidityLocked },
    recommendation: {
      positionSize: score >= 65 ? '2-4% du portfolio' : score >= 40 ? '0.5-1% max' : '0% — ne pas entrer',
      takeProfit: score >= 65 ? '+80 à +200%' : score >= 40 ? '+40 à +80%' : 'Éviter',
      stopLoss: score >= 65 ? '-20%' : score >= 40 ? '-30%' : '—',
      note: score >= 65 ? 'Signaux positifs. Entre en petite position et prends du profit tôt.' : score >= 40 ? 'Signaux ambigus. 1% max du portfolio, stop loss strict.' : 'Trop de signaux critiques. Passe à la prochaine opportunité.',
    },
  };
}
