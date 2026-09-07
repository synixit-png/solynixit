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
  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Trop de requêtes. Réessaie dans une minute.' });
  }
  const { address } = req.query;
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Adresse invalide.' });
  }
  try {
    const [tokenData, securityData, marketData] = await Promise.allSettled([
      fetchTokenOverview(address),
      fetchTokenSecurity(address),
      fetchDexScreener(address),
    ]);
    const token = tokenData.status === 'fulfilled' ? tokenData.value : null;
    const security = securityData.status === 'fulfilled' ? securityData.value : null;
    const dex = marketData.status === 'fulfilled' ? marketData.value : null;
    return res.status(200).json(buildAnalysis(address, token, security, dex));
  } catch (err) {
    return res.status(500).json({ error: "Erreur lors de l'analyse. Réessaie." });
  }
}

async function fetchTokenOverview(address) {
  const r = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${address}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.data || null;
}

async function fetchTokenSecurity(address) {
  const r = await fetch(`https://public-api.birdeye.so/defi/token_security?address=${address}`, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.data || null;
}

async function fetchDexScreener(address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j.pairs?.[0] || null;
}

function buildAnalysis(address, token, security, dex) {
  const name = token?.name || dex?.baseToken?.name || null;
  const symbol = token?.symbol || dex?.baseToken?.symbol || null;
  const holders = token?.holder || 0;
  const liquidityUsd = dex?.liquidity?.usd || token?.liquidity || 0;
  const volume24h = dex?.volume?.h24 || token?.v24hUSD || 0;
  const mcap = token?.mc || dex?.fdv || 0;
  const top10pct = security?.top10HolderPercent ? Math.round(security.top10HolderPercent * 100) : null;
  const securityAvailable = security !== null;
  const mintRevoked = securityAvailable ? (security.mintAuthority === null || security.mintAuthority === '') : null;
  const freezeRevoked = securityAvailable ? (security.freezeAuthority === null || security.freezeAuthority === '') : null;
  const liquidityLocked = securityAvailable ? security.lpLocked > 0.5 : null;
  const devSoldPct = securityAvailable ? Math.round((security.devSoldPercent || 0) * 100) : null;
  const creatorAddress = security?.creatorAddress || null;
  const prevRugs = securityAvailable ? (security.rugged ? 1 : 0) : null;
  const linkedWallets = securityAvailable ? (security.relatedAddresses?.length || 0) : null;
  const createdAt = token?.createdAt || dex?.pairCreatedAt;
  const ageMs = createdAt ? Date.now() - createdAt : null;
  const ageHours = ageMs ? Math.floor(ageMs / 3600000) : null;
  const ageLabel = ageHours === null ? 'Inconnu' : ageHours < 24 ? ageHours + 'h' : ageHours < 720 ? Math.floor(ageHours / 24) + 'j' : Math.floor(ageHours / 720) + ' mois';

  const signals = [
    { name: 'Liquidité lockée', status: liquidityLocked === null ? 'warn' : liquidityLocked ? 'ok' : 'bad', good: 'Liquidité verrouillée — le dev ne peut pas retirer les fonds.', bad: liquidityLocked === null ? 'Donnée de sécurité indisponible — impossible de vérifier ce signal.' : 'Liquidité NON lockée — rug pull possible à tout moment.', impact: 'Si le dev retire la liquidité, le token vaut 0 en secondes.', weight: 20, eliminatory: true },
    { name: 'Mint authority révoquée', status: mintRevoked === null ? 'warn' : mintRevoked ? 'ok' : 'bad', good: 'Impossible de créer de nouveaux tokens — supply fixe.', bad: mintRevoked === null ? 'Donnée de sécurité indisponible — impossible de vérifier ce signal.' : "Mint authority active — le dev peut créer des tokens à l'infini.", impact: 'Création illimitée = dilution et destruction de valeur.', weight: 18, eliminatory: true },
    { name: 'Freeze authority révoquée', status: freezeRevoked === null ? 'warn' : freezeRevoked ? 'ok' : 'bad', good: 'Personne ne peut bloquer tes tokens.', bad: freezeRevoked === null ? 'Donnée de sécurité indisponible — impossible de vérifier ce signal.' : 'Freeze authority active — le dev peut geler ton wallet.', impact: 'Tu pourrais être bloqué et incapable de vendre.', weight: 12, eliminatory: false },
    { name: 'Distribution des holders', status: holders > 3000 ? 'ok' : holders > 500 ? 'warn' : 'bad', good: holders.toLocaleString('fr') + ' holders — bonne distribution.', bad: holders.toLocaleString('fr') + ' holders seulement — manipulation facile.', impact: 'Peu de holders = prix contrôlé par quelques wallets.', weight: 12, eliminatory: false },
    { name: 'Concentration top 10 wallets', status: top10pct === null ? 'warn' : top10pct < 25 ? 'ok' : top10pct < 50 ? 'warn' : 'bad', good: 'Top 10 = ' + top10pct + '% — bien distribué.', bad: top10pct === null ? 'Données non disponibles.' : 'Top 10 = ' + top10pct + '% — dump massif possible.', impact: "Si ces wallets vendent ensemble, le prix s'effondre.", weight: 14, eliminatory: false },
    { name: 'Comportement du développeur', status: devSoldPct === null ? 'warn' : devSoldPct < 15 ? 'ok' : devSoldPct < 50 ? 'warn' : 'bad', good: 'Dev a vendu ' + devSoldPct + '% — reste engagé.', bad: devSoldPct === null ? 'Donnée de sécurité indisponible — impossible de vérifier ce signal.' : 'Dev a vendu ' + devSoldPct + '% de sa position — signal de sortie.', impact: "Un dev qui vend massivement n'a plus d'intérêt à développer.", weight: 12, eliminatory: false },
    { name: 'Historique du créateur', status: prevRugs === null ? 'warn' : prevRugs === 0 ? 'ok' : 'bad', good: 'Aucun rug pull antérieur détecté.', bad: prevRugs === null ? 'Donnée de sécurité indisponible — impossible de vérifier ce signal.' : prevRugs + ' rug pull(s) antérieur(s) sur ce wallet.', impact: 'Un serial rugger a 90% de chances de recommencer.', weight: 8, eliminatory: true },
    { name: 'Coordination de wallets', status: linkedWallets === null ? 'warn' : linkedWallets > 3 ? 'bad' : linkedWallets > 1 ? 'warn' : 'ok', good: 'Pas de coordination détectée.', bad: linkedWallets === null ? 'Donnée de sécurité indisponible — impossible de vérifier ce signal.' : linkedWallets + ' wallets liés — pump & dump possible.', impact: 'Wallets coordonnés = manipulation organisée.', weight: 4, eliminatory: false },
  ];

  let score = 0, hasEliminatory = false;
  signals.forEach(s => {
    if (s.status === 'ok') score += s.weight;
    else if (s.status === 'warn') score += s.weight * 0.4;
    else if (s.eliminatory) hasEliminatory = true;
  });
  if (hasEliminatory) score = Math.min(score, 35);
  score = Math.round(Math.max(0, Math.min(100, score)));

  let reputationScore = 100;
  if (prevRugs > 0) reputationScore -= 60;
  if (devSoldPct > 50) reputationScore -= 20;
  if (linkedWallets > 3) reputationScore -= 15;
  if (ageHours !== null && ageHours < 48) reputationScore -= 10;
  reputationScore = Math.max(0, reputationScore);
  const reputationLabel = reputationScore >= 70 ? 'Fiable' : reputationScore >= 40 ? 'Suspect' : 'Dangereux';

  return {
    address, name, symbol, score, signals,
    creator: { address: creatorAddress, prevRugs, prevTokens: linkedWallets, walletAge: ageLabel, devSoldPct, linkedWallets, reputationScore, reputationLabel },
    market: { holders, top10pct, liquidityUsd: Math.round(liquidityUsd), volume24h: Math.round(volume24h), mcap: Math.round(mcap), age: ageLabel, liquidityLocked },
    recommendation: {
      positionSize: score >= 65 ? '2-4% du portfolio' : score >= 40 ? '0.5-1% max' : '0% — ne pas entrer',
      takeProfit: score >= 65 ? '+80 à +200%' : score >= 40 ? '+40 à +80%' : 'Éviter',
      stopLoss: score >= 65 ? '-20%' : score >= 40 ? '-30%' : '—',
      note: score >= 65 ? 'Signaux positifs. Entre en petite position et prends du profit tôt.' : score >= 40 ? 'Signaux ambigus. 1% max du portfolio, stop loss strict.' : 'Trop de signaux critiques. Passe à la prochaine opportunité.',
    },
  };
}
