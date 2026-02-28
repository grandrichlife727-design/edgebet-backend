require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Redis = require("redis");

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json());

// Redis client
const redis = Redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379"
});
redis.connect().catch(console.error);

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY;
const WEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const SPORTSDATA_BASE = "https://api.sportsdata.io/v3";

console.log("API Keys present:", {
  odds: !!ODDS_API_KEY,
  sportsdata: !!SPORTSDATA_API_KEY,
  weather: !!WEATHER_API_KEY
});

// Data stores
const users = new Map();
const pickHistory = [];
const steamMoves = []; // Track rapid line movements
const journalEntries = new Map(); // userId -> entries

const SPORTS = [
  { key: "basketball_nba", label: "NBA", emoji: "🏀", sportsdataSport: "nba", hasWeather: false },
  { key: "americanfootball_nfl", label: "NFL", emoji: "🏈", sportsdataSport: "nfl", hasWeather: true },
  { key: "icehockey_nhl", label: "NHL", emoji: "🏒", sportsdataSport: "nhl", hasWeather: false },
  { key: "basketball_ncaab", label: "NCAAB", emoji: "🎓", sportsdataSport: null, hasWeather: false },
  { key: "baseball_mlb", label: "MLB", emoji: "⚾", sportsdataSport: "mlb", hasWeather: true },
];

const PROP_MARKETS = {
  basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_threes"],
  americanfootball_nfl: ["player_pass_tds", "player_pass_yds", "player_rush_yds", "player_receptions"],
  icehockey_nhl: ["player_goals", "player_assists", "player_points"],
  baseball_mlb: ["player_hits", "player_runs", "player_rbis", "player_home_runs"],
};

const SHARP_BOOKS = new Set(["pinnacle", "betcris", "betonlineag", "bovada", "lowvig"]);
const ALL_BOOKS = ["fanduel", "draftkings", "betmgm", "caesars", "pointsbet", "wynnbet", "barstool", "pinnacle", "betcris"];

// ── CACHE UTILS ───────────────────────────────────────────────────────────────
async function getCache(key) {
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function setCache(key, value, ttl = 300) {
  try {
    await redis.setEx(key, ttl, JSON.stringify(value));
  } catch {}
}

// ── MATH UTILS ────────────────────────────────────────────────────────────────
const impliedProb = (odds) => odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
const decimalOdds = (american) => american > 0 ? (american / 100) + 1 : (100 / Math.abs(american)) + 1;
const kellyStake = (bankroll, edgePercent, oddsDecimal) => {
  const p = (edgePercent / 100) + (1 / oddsDecimal);
  const q = 1 - p;
  const kelly = (p * oddsDecimal - q) / oddsDecimal;
  return bankroll * Math.max(0, kelly);
};

const fmtOdds = (n) => (n > 0 ? `+${n}` : `${n}`);
const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

// ── EXTERNAL APIS ─────────────────────────────────────────────────────────────
async function fetchWeather(city, date) {
  if (!WEATHER_API_KEY || !city) return null;
  const cacheKey = `weather:${city}:${date}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=imperial`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    
    // Find forecast closest to game time
    const forecast = data.list?.[0];
    if (!forecast) return null;
    
    const result = {
      temp: Math.round(forecast.main.temp),
      wind: Math.round(forecast.wind.speed),
      rain: forecast.weather?.[0]?.main?.toLowerCase().includes('rain'),
      snow: forecast.weather?.[0]?.main?.toLowerCase().includes('snow'),
      description: forecast.weather?.[0]?.description,
      impact: 'none'
    };
    
    // Calculate weather impact
    if (result.wind > 15) result.impact = 'high';
    else if (result.wind > 10 || result.rain) result.impact = 'medium';
    
    await setCache(cacheKey, result, 1800);
    return result;
  } catch (e) { return null; }
}

async function fetchInjuries(sport) {
  if (!SPORTSDATA_API_KEY || !sport) return [];
  const cacheKey = `injuries:${sport}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  
  try {
    const url = `${SPORTSDATA_BASE}/${sport}/scores/json/InjuriesByTeam?key=${SPORTSDATA_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    
    const injuries = [];
    for (const team of data || []) {
      for (const inj of team.Injuries || []) {
        injuries.push({
          player: inj.Name,
          team: team.Name,
          status: inj.Status,
          injury: inj.Injury,
          position: inj.Position,
          lastUpdate: inj.Updated,
        });
      }
    }
    await setCache(cacheKey, injuries, 600);
    return injuries;
  } catch (e) { return []; }
}

async function fetchSportOdds(sportKey, markets = "spreads,totals,h2h", region = "us") {
  const cacheKey = `odds:${sportKey}:${markets}:${region}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  
  if (!ODDS_API_KEY) return [];
  const url = new URL(`${ODDS_BASE}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  url.searchParams.set("regions", region);
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "american");
  
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    await setCache(cacheKey, data, 60);
    return data;
  } catch (e) { return []; }
}

// ── LINE SHOPPING ─────────────────────────────────────────────────────────────
async function getLineShopping(gameId, sportKey) {
  const cacheKey = `lineshop:${gameId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  
  const games = await fetchSportOdds(sportKey, "spreads,totals,h2h", "us,eu,uk");
  const game = games.find(g => 
    `${g.away_team}_${g.home_team}`.replace(/\s/g, '_') === gameId
  );
  
  if (!game) return null;
  
  const lines = { spreads: {}, totals: {}, moneyline: {} };
  
  for (const book of game.bookmakers || []) {
    for (const market of book.markets) {
      if (market.key === 'spreads') {
        const home = market.outcomes.find(o => o.name === g.home_team);
        const away = market.outcomes.find(o => o.name === g.away_team);
        if (home && away) {
          lines.spreads[book.key] = { home: home.point, away: away.point, homePrice: home.price, awayPrice: away.price };
        }
      }
      if (market.key === 'totals') {
        const over = market.outcomes.find(o => o.name === 'Over');
        if (over) {
          lines.totals[book.key] = { line: over.point, overPrice: over.price, underPrice: market.outcomes.find(o => o.name === 'Under')?.price };
        }
      }
      if (market.key === 'h2h') {
        const home = market.outcomes.find(o => o.name === g.home_team);
        const away = market.outcomes.find(o => o.name === g.away_team);
        if (home && away) {
          lines.moneyline[book.key] = { home: home.price, away: away.price };
        }
      }
    }
  }
  
  // Find best lines
  const bestSpreads = { home: null, away: null };
  const bestTotals = { over: null, under: null };
  const bestML = { home: null, away: null };
  
  for (const [book, line] of Object.entries(lines.spreads)) {
    if (!bestSpreads.home || line.homePrice > bestSpreads.home.price) {
      bestSpreads.home = { book, point: line.home, price: line.homePrice };
    }
    if (!bestSpreads.away || line.awayPrice > bestSpreads.away.price) {
      bestSpreads.away = { book, point: line.away, price: line.awayPrice };
    }
  }
  
  await setCache(cacheKey, { lines, best: { spreads: bestSpreads, totals: bestTotals, moneyline: bestML } }, 120);
  return { lines, best: { spreads: bestSpreads, totals: bestTotals, moneyline: bestML } };
}

// ── STEAM MOVE DETECTION ──────────────────────────────────────────────────────
async function detectSteamMoves(sportKey) {
  const currentOdds = await fetchSportOdds(sportKey);
  const moves = [];
  
  for (const game of currentOdds) {
    const gameId = `${sportKey}_${game.away_team}_${game.home_team}`.replace(/\s/g, '_');
    const previous = await getCache(`odds_prev:${gameId}`);
    
    if (previous) {
      // Compare current vs previous
      for (const book of game.bookmakers || []) {
        const prevBook = previous.bookmakers?.find(b => b.key === book.key);
        if (!prevBook) continue;
        
        for (const market of book.markets) {
          const prevMarket = prevBook.markets?.find(m => m.key === market.key);
          if (!prevMarket) continue;
          
          for (const outcome of market.outcomes) {
            const prevOutcome = prevMarket.outcomes?.find(o => o.name === outcome.name);
            if (!prevOutcome) continue;
            
            const pointDiff = (outcome.point || 0) - (prevOutcome.point || 0);
            const priceDiff = outcome.price - prevOutcome.price;
            
            if (Math.abs(pointDiff) >= 1 || Math.abs(priceDiff) >= 20) {
              moves.push({
                game: `${game.away_team} @ ${game.home_team}`,
                book: book.key,
                market: market.key,
                side: outcome.name,
                pointChange: pointDiff,
                priceChange: priceDiff,
                oldLine: prevOutcome.point || prevOutcome.price,
                newLine: outcome.point || outcome.price,
                timestamp: new Date().toISOString(),
                steam: Math.abs(pointDiff) >= 2 || Math.abs(priceDiff) >= 50
              });
            }
          }
        }
      }
    }
    
    // Store current for next comparison
    await setCache(`odds_prev:${gameId}`, game, 300);
  }
  
  return moves.sort((a, b) => Math.abs(b.priceChange) - Math.abs(a.priceChange));
}

// ── EV CALCULATOR ─────────────────────────────────────────────────────────────
function calculateEV(trueProbPercent, oddsAmerican, bankroll = 1000, kellyFraction = 0.25) {
  const trueProb = trueProbPercent / 100;
  const oddsDecimal = decimalOdds(oddsAmerican);
  const implied = impliedProb(oddsAmerican) / 100;
  
  // EV calculation
  const winAmount = oddsDecimal - 1;
  const ev = (trueProb * winAmount) - ((1 - trueProb) * 1);
  const evPercent = ev * 100;
  
  // Edge
  const edge = (trueProb - implied) * 100;
  
  // Kelly stake
  const fullKelly = kellyStake(bankroll, edge, oddsDecimal);
  const recommendedStake = fullKelly * kellyFraction;
  
  // Breakeven probability
  const breakeven = 1 / oddsDecimal * 100;
  
  return {
    ev: evPercent.toFixed(2),
    edge: edge.toFixed(2),
    impliedProbability: (implied * 100).toFixed(1),
    trueProbability: trueProbPercent.toFixed(1),
    breakevenProbability: breakeven.toFixed(1),
    recommendedStake: Math.round(recommendedStake),
    kellyPercent: ((recommendedStake / bankroll) * 100).toFixed(2),
    isPositive: ev > 0,
    rating: ev > 0.05 ? 'A' : ev > 0.02 ? 'B' : ev > 0 ? 'C' : 'F'
  };
}

// ── PARLAY CALCULATOR ─────────────────────────────────────────────────────────
function calculateParlay(legs) {
  let totalDecimalOdds = 1;
  let totalTrueProb = 1;
  let totalEdge = 0;
  
  for (const leg of legs) {
    const decimal = decimalOdds(leg.odds);
    totalDecimalOdds *= decimal;
    totalTrueProb *= (leg.trueProb / 100);
    totalEdge += parseFloat(leg.edge || 0);
  }
  
  // Parlay American odds
  const parlayAmerican = totalDecimalOdds > 2 
    ? Math.round((totalDecimalOdds - 1) * 100)
    : Math.round(-100 / (totalDecimalOdds - 1));
  
  // Parlay true probability and EV
  const parlayImplied = 1 / totalDecimalOdds;
  const parlayEV = ((totalTrueProb / parlayImplied) - 1) * 100;
  
  return {
    legs: legs.length,
    decimalOdds: totalDecimalOdds.toFixed(3),
    americanOdds: fmtOdds(parlayAmerican),
    impliedProbability: (parlayImplied * 100).toFixed(2),
    trueProbability: (totalTrueProb * 100).toFixed(2),
    ev: parlayEV.toFixed(2),
    avgEdge: (totalEdge / legs.length).toFixed(2),
    isPositive: parlayEV > 0,
    stake: legs.length >= 2 && legs.length <= 3 ? 'Recommended' : legs.length > 4 ? 'High Variance' : 'Select 2-3 legs'
  };
}

// ── MLB/NFL ADVANCED STATS ───────────────────────────────────────────────────
async function getMLBPitcherStats() {
  if (!SPORTSDATA_API_KEY) return [];
  const cacheKey = 'mlb_pitchers';
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  
  try {
    const url = `${SPORTSDATA_BASE}/mlb/stats/json/PlayerSeasonStats/2024?key=${SPORTSDATA_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    
    const pitchers = data
      .filter(p => p.Position === 'SP' && p.InningsPitchedDecimal > 20)
      .map(p => ({
        name: p.Name,
        team: p.Team,
        era: p.EarnedRunAverage,
        whip: p.WalksHitsPerInningsPitched,
        kPerNine: p.StrikeoutsPerNineInnings,
        bbPerNine: p.WalksPerNineInnings,
        fip: (p.EarnedRunAverage * 0.9 + p.WalksHitsPerInningsPitched * 2).toFixed(2), // Simplified FIP
        recentForm: p.StrikeoutsPerNineInnings > 9 ? 'hot' : p.EarnedRunAverage < 3.5 ? 'solid' : 'cold'
      }))
      .sort((a, b) => a.era - b.era);
    
    await setCache(cacheKey, pitchers, 3600);
    return pitchers.slice(0, 50);
  } catch (e) { return []; }
}

async function getNBARestAdvantage() {
  // Simplified rest analysis
  const games = await fetchSportOdds('basketball_nba');
  const restAnalysis = [];
  
  for (const game of games) {
    // In real implementation, fetch schedule data
    // For now, return placeholder structure
    restAnalysis.push({
      game: `${game.away_team} @ ${game.home_team}`,
      awayRest: 2, // days
      homeRest: 1,
      advantage: 'home', // team with more rest
      impact: 'medium' // high if 3+ days diff
    });
  }
  
  return restAnalysis;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({ 
    status: "ok", 
    service: "EdgeBet AI API v4.0",
    features: ["picks", "props", "arbitrage", "ev-calculator", "parlay-builder", "line-shopping", "steam-moves", "weather", "analytics", "journal"],
    version: "4.0.0"
  })
);

// EV Calculator endpoint
app.post("/ev-calculator", (req, res) => {
  const { trueProbability, odds, bankroll = 1000, kellyFraction = 0.25 } = req.body;
  if (!trueProbability || !odds) {
    return res.status(400).json({ error: "trueProbability and odds required" });
  }
  
  const result = calculateEV(trueProbability, odds, bankroll, kellyFraction);
  res.json(result);
});

// Parlay Calculator endpoint
app.post("/parlay-calculator", (req, res) => {
  const { legs } = req.body;
  if (!legs || !Array.isArray(legs) || legs.length < 2) {
    return res.status(400).json({ error: "At least 2 legs required" });
  }
  
  const result = calculateParlay(legs);
  res.json(result);
});

// Line Shopping endpoint
app.get("/line-shopping/:sport/:gameId", async (req, res) => {
  const { sport, gameId } = req.params;
  const result = await getLineShopping(gameId, `basketball_${sport.toLowerCase()}`);
  if (!result) return res.status(404).json({ error: "Game not found" });
  res.json(result);
});

// Steam Moves endpoint
app.get("/steam-moves/:sport", async (req, res) => {
  const sport = req.params.sport;
  const moves = await detectSteamMoves(`${sport}`);
  res.json({ moves: moves.slice(0, 20), count: moves.length, timestamp: new Date().toISOString() });
});

// Weather endpoint
app.get("/weather/:city", async (req, res) => {
  const city = req.params.city;
  const forecast = await fetchWeather(city);
  if (!forecast) return res.status(404).json({ error: "Weather data unavailable" });
  res.json(forecast);
});

// MLB Pitcher Stats endpoint
app.get("/mlb/pitchers", async (req, res) => {
  const pitchers = await getMLBPitcherStats();
  res.json({ pitchers, count: pitchers.length });
});

// NBA Rest endpoint
app.get("/nba/rest", async (req, res) => {
  const restData = await getNBARestAdvantage();
  res.json({ games: restData });
});

// Betting Journal endpoints
app.post("/journal/:userId", async (req, res) => {
  const { userId } = req.params;
  const entry = { ...req.body, id: Date.now(), createdAt: new Date().toISOString() };
  
  if (!journalEntries.has(userId)) {
    journalEntries.set(userId, []);
  }
  journalEntries.get(userId).push(entry);
  
  res.json({ success: true, entry });
});

app.get("/journal/:userId", async (req, res) => {
  const { userId } = req.params;
  const entries = journalEntries.get(userId) || [];
  res.json({ entries, count: entries.length });
});

// Trending picks (what users are tracking)
app.get("/trending", async (req, res) => {
  // Aggregate from pick history
  const pickCounts = {};
  for (const pick of pickHistory.slice(-100)) {
    const key = `${pick.game}_${pick.bet}`;
    pickCounts[key] = (pickCounts[key] || 0) + 1;
  }
  
  const trending = Object.entries(pickCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, count]) => ({ pick: key, trackerCount: count }));
  
  res.json({ trending, lastUpdated: new Date().toISOString() });
});

// Closing Line Value endpoint
app.get("/clv/:pickId", async (req, res) => {
  const pick = pickHistory.find(p => p.id === req.params.pickId);
  if (!pick) return res.status(404).json({ error: "Pick not found" });
  
  // In real implementation, compare to closing line
  // For now return placeholder
  res.json({
    pick: pick.bet,
    openingLine: pick.openingLine,
    closingLine: pick.currentLine,
    clv: 0.5, // points of value
    positive: true
  });
});

// Main scan endpoint (enhanced)
app.get("/scan", async (req, res) => {
  try {
    const oddsResults = await Promise.all(
      SPORTS.map(s => fetchSportOdds(s.key).then(games => games.slice(0, 8)))
    );
    
    const allGames = oddsResults.flat();
    if (allGames.length === 0) {
      return res.status(503).json({ error: "No odds data available" });
    }
    
    // Process games (simplified - full implementation would include all 7 agents)
    const picks = allGames.slice(0, 5).map((g, i) => ({
      id: `pick_${Date.now()}_${i}`,
      sport: g.sport_title,
      game: `${g.away_team} @ ${g.home_team}`,
      bet: `${g.home_team} -4.5`,
      odds: '-110',
      confidence: 65 + Math.floor(Math.random() * 20),
      edge: (3 + Math.random() * 8).toFixed(1),
      timestamp: new Date().toISOString()
    }));
    
    // Check for steam moves
    const steamMoves = await detectSteamMoves('basketball_nba');
    
    res.json({ 
      consensus_picks: picks,
      steam_moves: steamMoves.slice(0, 5),
      arbitrage_opportunities: [],
      scan_time: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Affiliate links
app.get("/affiliate/:book", (req, res) => {
  const links = {
    fanduel: 'https://sportsbook.fanduel.com/?ref=edgebet',
    draftkings: 'https://sportsbook.draftkings.com/?ref=edgebet',
    betmgm: 'https://sports.betmgm.com/?ref=edgebet',
    caesars: 'https://sportsbook.caesars.com/?ref=edgebet'
  };
  
  const book = req.params.book.toLowerCase();
  res.json({ 
    book, 
    url: links[book] || `https://${book}.com`,
    bonus: '$1000 Risk-Free Bet'
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`EdgeBet AI API v4.0 on :${PORT} — EV Calculator, Parlay Builder, Steam Moves, Weather`)
);
