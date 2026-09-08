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
  const liquidityLocked = lpLockedPct === null ? null : lpLockedPct >= 50;
  const linkedWallets = countLinkedWallets(insiders);
  // Not exposed by RugCheck's single-token report — left honestly unavailable
  // rather than guessed, until we integrate a source that actually provides it.
  const devSoldPct = null;

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
    { name: 'Liquidité lockée', known: liquidityLocked !== null, status: liquidityLocked === null ? 'warn' : liquidityLocked ? 'ok' : 'bad', good: 'Liquidité lockée à ' + lpLockedPct + '% — le dev ne peut pas retirer les fonds facilement.', bad: liquidityLocked === null ? notTrackedMsg : 'Liquidité lockée à seulement ' + lpLockedPct + '% — rug pull possible à tout moment.', impact: 'Si le dev retire la liquidité, le token vaut 0 en secondes.', weight: 20, eliminatory: true },
    { name: 'Mint authority révoquée', known: mintRevoked !== null, status: mintRevoked === null ? 'warn' : mintRevoked ? 'ok' : 'bad', good: 'Impossible de créer de nouveaux tokens — supply fixe.', bad: mintRevoked === null ? fetchFailedMsg : "Mint authority active — le dev peut créer des tokens à l'infini.", impact: 'Création illimitée = dilution et destruction de valeur.', weight: 18, eliminatory: true },
    { name: 'Freeze authority révoquée', known: freezeRevoked !== null, status: freezeRevoked === null ? 'warn' : freezeRevoked ? 'ok' : 'bad', good: 'Personne ne peut bloquer tes tokens.', bad: freezeRevoked === null ? fetchFailedMsg : 'Freeze authority active — le dev peut geler ton wallet.', impact: 'Tu pourrais être bloqué et incapable de vendre.', weight: 12, eliminatory: false },
    { name: 'Distribution des holders', known: true, status: holderStatus, good: holders.toLocaleString('fr') + ' holders' + holderAgeNote + ' — bonne distribution pour son âge.', bad: holders.toLocaleString('fr') + ' holders seulement' + holderAgeNote + ' — manipulation facile.', impact: 'Peu de holders = prix contrôlé par quelques wallets.', weight: 12, eliminatory: false },
    { name: 'Concentration top 10 wallets', known: top10pct !== null, status: top10pct === null ? 'warn' : top10pct < 25 ? 'ok' : top10pct < 50 ? 'warn' : 'bad', good: 'Top 10 = ' + top10pct + '% — bien distribué.', bad: top10pct === null ? 'Données non disponibles.' : 'Top 10 = ' + top10pct + '% — dump massif possible.', impact: "Si ces wallets vendent ensemble, le prix s'effondre.", weight: 14, eliminatory: false },
    { name: 'Comportement du développeur', known: false, status: 'warn', good: 'Dev a vendu peu de sa position — reste engagé.', bad: notTrackedMsg, impact: "Un dev qui vend massivement n'a plus d'intérêt à développer.", weight: 12, eliminatory: false },
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
  const confidence = totalWeight > 0 ? Math.round((knownWeight / totalWeight) * 100) : 0;

  let scoreSum = 0, hasEliminatory = false;
  signals.forEach(s => {
    if (!s.known) return;
    if (s.status === 'ok') scoreSum += s.weight;
    else if (s.status === 'warn') scoreSum += s.weight * 0.4;
    else if (s.eliminatory) hasEliminatory = true;
  });
  let score = knownWeight > 0 ? Math.round((scoreSum / knownWeight) * 100) : 0;
  if (hasEliminatory) score = Math.min(score, 35);
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
    address, name, symbol, score, confidence, scoreCapped: hasEliminatory, signals,
    creator: { address: creatorAddress, prevRugs, walletAge: ageLabel, devSoldPct, linkedWallets, reputationScore, reputationLabel },
    market: { holders, top10pct, liquidityUsd: Math.round(liquidityUsd), volume24h: Math.round(volume24h), mcap: Math.round(mcap), age: ageLabel, liquidityLocked },
    recommendation: {
      positionSize: score >= 65 ? '2-4% du portfolio' : score >= 40 ? '0.5-1% max' : '0% — ne pas entrer',
      takeProfit: score >= 65 ? '+80 à +200%' : score >= 40 ? '+40 à +80%' : 'Éviter',
      stopLoss: score >= 65 ? '-20%' : score >= 40 ? '-30%' : '—',
      note: score >= 65 ? 'Signaux positifs. Entre en petite position et prends du profit tôt.' : score >= 40 ? 'Signaux ambigus. 1% max du portfolio, stop loss strict.' : 'Trop de signaux critiques. Passe à la prochaine opportunité.',
    },
  };
}
