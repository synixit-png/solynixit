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

// Signals that describe point-in-time on-chain STATE (holder distribution,
// mint/freeze authority, LP lock %, insider wallet graph) can't be
// reconstructed historically from Birdeye/RugCheck/DexScreener — those APIs
// only expose the current state of an account, not a log of what it was at
// an arbitrary past moment. Doing that properly would require querying a
// Solana archive RPC node and replaying account state, which is a different
// project. The one thing that IS genuinely historical and available (Birdeye
// candle history) is price — so backtest mode only scores the price-crash
// signal, and explicitly marks every other signal as unavailable rather than
// silently reusing today's state for a past date.
const UNAVAILABLE_MSG = "Non reconstituable historiquement — cette donnée reflète l'état actuel du compte on-chain, pas un historique. Nécessiterait un nœud RPC archive.";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (isRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Trop de requêtes. Réessaie dans une minute.' });
  }
  const { address, at } = req.query;
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    return res.status(400).json({ error: 'Adresse invalide.' });
  }
  const atMs = parseAt(at);
  if (atMs === null) {
    return res.status(400).json({ error: "Paramètre 'at' invalide — utilise un timestamp Unix (secondes ou ms) ou une date ISO." });
  }
  if (atMs > Date.now()) {
    return res.status(400).json({ error: "Le paramètre 'at' doit être dans le passé." });
  }
  try {
    const [overviewData, priceWindowData, validationWindowData] = await Promise.allSettled([
      fetchTokenOverview(address),
      fetchHistoricalPrice(address, atMs - 2 * 3600_000, atMs, '15m'),
      fetchHistoricalPrice(address, atMs, Math.min(atMs + 24 * 3600_000, Date.now()), '1H'),
    ]);
    const overview = overviewData.status === 'fulfilled' ? overviewData.value : null;
    const priceItems = priceWindowData.status === 'fulfilled' ? priceWindowData.value : null;
    const validationItems = validationWindowData.status === 'fulfilled' ? validationWindowData.value : null;
    return res.status(200).json(buildBacktestAnalysis(address, atMs, overview, priceItems, validationItems));
  } catch (err) {
    return res.status(500).json({ error: "Erreur lors du backtest. Réessaie." });
  }
}

function parseAt(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    // Accept either unix seconds or unix milliseconds.
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
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

async function fetchHistoricalPrice(address, fromMs, toMs, type) {
  const timeFrom = Math.floor(fromMs / 1000);
  const timeTo = Math.floor(toMs / 1000);
  if (timeTo <= timeFrom) return null;
  try {
    const r = await fetch(
      `https://public-api.birdeye.so/defi/history_price?address=${address}&address_type=token&type=${type}&time_from=${timeFrom}&time_to=${timeTo}`,
      { headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' }, cache: 'no-store' }
    );
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.data?.items) ? j.data.items : null;
  } catch (e) {
    console.error('Birdeye history_price exception', e);
    return null;
  }
}

// Picks the candle closest to targetUnix (seconds). Candle sets from Birdeye
// are sparse near the edges of the requested window (a token can be younger
// than the window, or a gap in trading), so nearest-match is safer than
// assuming an exact timestamp exists.
function closestItem(items, targetUnix) {
  if (!Array.isArray(items) || !items.length) return null;
  let best = null, bestDiff = Infinity;
  for (const item of items) {
    const t = Number(item?.unixTime);
    const v = Number(item?.value);
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    const diff = Math.abs(t - targetUnix);
    if (diff < bestDiff) { bestDiff = diff; best = item; }
  }
  return best;
}

function buildBacktestAnalysis(address, atMs, overview, priceItems, validationItems) {
  const atUnix = Math.floor(atMs / 1000);
  const name = overview?.name || null;
  const symbol = overview?.symbol || null;

  const priceAtT = closestItem(priceItems, atUnix);
  const priceBefore = closestItem(priceItems, atUnix - 3600);
  // Require both candles to be reasonably close to their target (within 20min)
  // — a nearest-match 3h away is not "the price at that moment", it's noise.
  const priceAtTOk = priceAtT && Math.abs(Number(priceAtT.unixTime) - atUnix) <= 1200;
  const priceBeforeOk = priceBefore && Math.abs(Number(priceBefore.unixTime) - (atUnix - 3600)) <= 1200;
  const priceChange1h = (priceAtTOk && priceBeforeOk && Number(priceBefore.value) > 0)
    ? Math.round(((Number(priceAtT.value) - Number(priceBefore.value)) / Number(priceBefore.value)) * 10000) / 100
    : null;

  const signals = [
    { name: 'Chute de prix récente', known: priceChange1h !== null, status: priceChange1h === null ? 'warn' : priceChange1h <= -50 ? 'bad' : priceChange1h <= -20 ? 'warn' : 'ok', good: 'Prix stable dans l\'heure précédant ce timestamp (' + (priceChange1h >= 0 ? '+' : '') + priceChange1h + '%).', bad: priceChange1h === null ? "Données de prix insuffisantes autour de ce timestamp." : 'Prix en chute de ' + Math.abs(priceChange1h) + '% dans l\'heure précédant ce timestamp — un dump était probablement déjà en cours.', impact: "Basé sur l'historique de prix Birdeye, pas sur l'état du compte.", weight: 16, eliminatory: true },
    { name: 'Liquidité lockée', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 20, eliminatory: true },
    { name: 'Mint authority révoquée', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 18, eliminatory: true },
    { name: 'Freeze authority révoquée', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 12, eliminatory: false },
    { name: 'Distribution des holders', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 12, eliminatory: false },
    { name: 'Concentration top 10 wallets', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 14, eliminatory: false },
    { name: 'Wallet du créateur', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 12, eliminatory: true },
    { name: 'Historique du créateur', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 8, eliminatory: true },
    { name: 'Coordination de wallets', known: false, status: 'warn', good: '', bad: UNAVAILABLE_MSG, impact: '', weight: 4, eliminatory: false },
  ];

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
  let score = knownWeight > 0 ? Math.round((scoreSum / knownWeight) * 100) : null;
  const scoreCapped = hasEliminatory;
  if (score !== null && hasEliminatory) score = Math.min(score, 35);

  // What actually happened afterward — shown purely so you can eyeball
  // whether the backtested verdict was later vindicated. This window looks
  // FORWARD from `at`, so it must never feed into the score above: a
  // backtest that peeks at the future isn't testing anything.
  const afterPrice = closestItem(validationItems, atUnix + 24 * 3600) || (Array.isArray(validationItems) && validationItems.length ? validationItems[validationItems.length - 1] : null);
  const priceChangeAfter = (priceAtTOk && afterPrice && Number(priceAtT.value) > 0 && Number.isFinite(Number(afterPrice.value)))
    ? Math.round(((Number(afterPrice.value) - Number(priceAtT.value)) / Number(priceAtT.value)) * 10000) / 100
    : null;

  return {
    address, name, symbol, backtest: true,
    at: new Date(atMs).toISOString(), atUnix,
    score, confidence, scoreCapped, priceChange1h,
    signals,
    limitations: [
      "Mode backtest : seul le signal 'Chute de prix récente' est réellement vérifiable a posteriori (via l'historique de prix Birdeye).",
      "Les 8 autres signaux décrivent l'état ACTUEL du compte on-chain (holders, authorities, LP lock, wallets liés) — ces APIs n'exposent pas leur historique, donc ils sont marqués non disponibles plutôt que de réutiliser l'état d'aujourd'hui pour une date passée.",
      "Un backtest complet et fidèle nécessiterait un nœud RPC Solana archive pour reconstruire l'état des comptes à un slot donné.",
    ],
    validation: {
      note: "Ce qui s'est passé après ce timestamp — donnée informative, PAS utilisée dans le score ci-dessus (pour ne pas biaiser le backtest en regardant le futur).",
      priceChangePct24hAfter: priceChangeAfter,
      dataAvailable: priceChangeAfter !== null,
    },
  };
}
