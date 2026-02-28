require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Redis = require("redis");

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json());

// Redis client for caching
const redis = Redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379"
});
redis.connect().catch(console.error);

const ODDS_API_KEY = process.env.ODDS_API_KEY || "316ba9e3bd49f1c65f604a292e1962a8";
const SPORTSDATA_API_KEY = process.env.SPORTSDATA_API_KEY;
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const SPORTSDATA_BASE = "https://api.sportsdata.io/v3";

console.log("ODDS_API_KEY present:", !!ODDS_API_KEY);
console.log("SPORTSDATA_API_KEY present:", !!SPORTSDATA_API_KEY);

// User accounts storage (in production use proper DB)
const users = new Map();
const pickHistory = []; // Store all picks with timestamps for analytics

const SPORTS = [
  { key: "basketball_nba", label: "NBA", emoji: "🏀", sportsdataSport: "nba" },
  { key: "americanfootball_nfl", label: "NFL", emoji: "🏈", sportsdataSport: "nfl" },
  { key: "icehockey_nhl", label: "NHL", emoji: "🏒", sportsdataSport: "nhl" },
  { key: "basketball_ncaab", label: "NCAAB", emoji: "🎓", sportsdataSport: null },
  { key: "baseball_mlb", label: "MLB", emoji: "⚾", sportsdataSport: "mlb" },
];

const PROP_MARKETS = {
  basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_blocks", "player_steals"],
  americanfootball_nfl: ["player_pass_tds", "player_pass_yds", "player_rush_yds", "player_receptions", "player_receiving_yds"],
  icehockey_nhl: ["player_goals", "player_assists", "player_points", "player_shots_on_goal"],
  baseball_mlb: ["player_hits", "player_runs", "player_rbis", "player_home_runs"],
};

const SHARP_BOOKS = new Set(["pinnacle", "betcris", "betonlineag", "bovada", "lowvig"]);

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
const impliedProb = (odds) =>
  odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

const devig = (price1, price2) => {
  const ip1 = impliedProb(price1);
  const ip2 = impliedProb(price2);
  const total = ip1 + ip2;
  return { side1: ip1 / total, side2: ip2 / total };
};

const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
const fmtOdds = (n) => (n > 0 ? `+${n}` : `${n}`);

// ── INJURY API ─────────────────────────────────────────────────────────────────
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
    
    // Flatten and format
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
    
    await setCache(cacheKey, injuries, 600); // 10 min cache
    return injuries;
  } catch (e) {
    console.warn("Injury API error:", e.message);
    return [];
  }
}

// ── ODDS FETCHER WITH CACHE ───────────────────────────────────────────────────
async function fetchSportOdds(sportKey, markets = "spreads,totals,h2h") {
  const cacheKey = `odds:${sportKey}:${markets}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;
  
  if (!ODDS_API_KEY) return [];
  const url = new URL(`${ODDS_BASE}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "american");
  
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    await setCache(cacheKey, data, 60); // 1 min cache
    return data;
  } catch (e) { return []; }
}

async function fetchPlayerProps(sportKey) {
  const markets = PROP_MARKETS[sportKey];
  if (!markets) return [];
  
  try {
    const url = new URL(`${ODDS_BASE}/sports/${sportKey}/events`);
    url.searchParams.set("apiKey", ODDS_API_KEY);
    const eventsRes = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!eventsRes.ok) return [];
    const events = await eventsRes.json();
    
    const propsData = [];
    for (const event of events.slice(0, 5)) {
      const propsUrl = new URL(`${ODDS_BASE}/sports/${sportKey}/events/${event.id}/odds`);
      propsUrl.searchParams.set("apiKey", ODDS_API_KEY);
      propsUrl.searchParams.set("regions", "us");
      propsUrl.searchParams.set("markets", markets.join(","));
      propsUrl.searchParams.set("oddsFormat", "american");
      
      const res = await fetch(propsUrl.toString(), { signal: AbortSignal.timeout(8000) });
      if (res.ok) propsData.push(await res.json());
    }
    return propsData;
  } catch (e) { return []; }
}

// ── PARSERS ────────────────────────────────────────────────────────────────────
function parseGame(g, sportLabel, emoji, injuries = []) {
  const spreadLines = [], totalLines = [], mlLines = [];
  const gameId = `${sportLabel}_${g.home_team}_${g.away_team}`.replace(/\s/g, '_');
  
  // Check for injuries affecting these teams
  const homeInjuries = injuries.filter(i => 
    g.home_team.toLowerCase().includes(i.team.toLowerCase()) ||
    i.team.toLowerCase().includes(g.home_team.split(' ').pop().toLowerCase())
  );
  const awayInjuries = injuries.filter(i => 
    g.away_team.toLowerCase().includes(i.team.toLowerCase()) ||
    i.team.toLowerCase().includes(g.away_team.split(' ').pop().toLowerCase())
  );
  
  const injuryImpact = [...homeInjuries, ...awayInjuries].filter(i => 
    i.status?.toLowerCase().includes('out') || 
    i.status?.toLowerCase().includes('doubtful')
  );

  for (const bk of (g.bookmakers || [])) {
    const isSharp = SHARP_BOOKS.has(bk.key);
    for (const mkt of bk.markets) {
      if (mkt.key === "spreads") {
        const home = mkt.outcomes.find((o) => o.name === g.home_team);
        const away = mkt.outcomes.find((o) => o.name === g.away_team);
        if (home && away)
          spreadLines.push({ book: bk.key, isSharp, homePoint: home.point, homePrice: home.price, awayPoint: away.point, awayPrice: away.price });
      }
      if (mkt.key === "totals") {
        const over = mkt.outcomes.find((o) => o.name === "Over");
        const under = mkt.outcomes.find((o) => o.name === "Under");
        if (over && under)
          totalLines.push({ book: bk.key, isSharp, point: over.point, overPrice: over.price, underPrice: under.price });
      }
      if (mkt.key === "h2h") {
        const home = mkt.outcomes.find((o) => o.name === g.home_team);
        const away = mkt.outcomes.find((o) => o.name === g.away_team);
        if (home && away)
          mlLines.push({ book: bk.key, isSharp, homePrice: home.price, awayPrice: away.price });
      }
    }
  }

  return {
    sport: sportLabel, emoji, gameId,
    game: `${g.away_team} @ ${g.home_team}`,
    homeTeam: g.home_team, awayTeam: g.away_team,
    commenceTime: g.commence_time,
    spreadLines, totalLines, mlLines,
    injuries: injuryImpact.map(i => ({
      player: i.player,
      status: i.status,
      impact: i.position?.match(/QB|PG|C|G/) ? 'high' : 'medium'
    })),
  };
}

function parseProps(gameData, sportLabel, emoji) {
  const props = [];
  const game = `${gameData.away_team} @ ${gameData.home_team}`;
  
  for (const bk of (gameData.bookmakers || [])) {
    for (const mkt of bk.markets) {
      for (const outcome of mkt.outcomes) {
        const existing = props.find(p => 
          p.player === outcome.description && 
          p.market === mkt.key &&
          p.line === outcome.point
        );
        
        if (existing) {
          existing.books.push({ book: bk.key, price: outcome.price });
          existing.bestPrice = Math.max(existing.bestPrice, outcome.price);
        } else {
          props.push({
            id: `${sportLabel}_${outcome.description}_${mkt.key}_${outcome.point}`.replace(/\s/g, '_'),
            sport: sportLabel, emoji, game,
            player: outcome.description,
            market: mkt.key,
            line: outcome.point,
            side: outcome.name,
            books: [{ book: bk.key, price: outcome.price }],
            bestPrice: outcome.price,
          });
        }
      }
    }
  }
  
  return props;
}

// ── ARBITRAGE DETECTOR ────────────────────────────────────────────────────────
function detectArbitrage(games) {
  const opportunities = [];
  
  for (const game of games) {
    if (game.spreadLines.length >= 2) {
      const awayLines = game.spreadLines.map(l => ({ ...l, implied: impliedProb(l.awayPrice) }));
      const homeLines = game.spreadLines.map(l => ({ ...l, implied: impliedProb(l.homePrice) }));
      
      for (const away of awayLines) {
        for (const home of homeLines) {
          if (away.book === home.book) continue;
          const totalProb = away.implied + home.implied;
          if (totalProb < 0.98) {
            const profit = ((1 / totalProb) - 1) * 100;
            opportunities.push({
              type: 'spread',
              game: game.game,
              sport: game.sport,
              awayBook: away.book,
              awayLine: away.awayPoint,
              awayOdds: fmtOdds(away.awayPrice),
              homeBook: home.book,
              homeLine: home.homePoint,
              homeOdds: fmtOdds(home.homePrice),
              profit: profit.toFixed(2),
              stake: {
                away: (100 * away.implied / totalProb).toFixed(2),
                home: (100 * home.implied / totalProb).toFixed(2),
              }
            });
          }
        }
      }
    }
    
    if (game.mlLines.length >= 2) {
      const awayML = game.mlLines.map(l => ({ book: l.book, odds: l.awayPrice, implied: impliedProb(l.awayPrice) }));
      const homeML = game.mlLines.map(l => ({ book: l.book, odds: l.homePrice, implied: impliedProb(l.homePrice) }));
      
      for (const away of awayML) {
        for (const home of homeML) {
          if (away.book === home.book) continue;
          const totalProb = away.implied + home.implied;
          if (totalProb < 0.98) {
            const profit = ((1 / totalProb) - 1) * 100;
            opportunities.push({
              type: 'moneyline',
              game: game.game,
              sport: game.sport,
              awayBook: away.book,
              awayOdds: fmtOdds(away.odds),
              homeBook: home.book,
              homeOdds: fmtOdds(home.odds),
              profit: profit.toFixed(2),
            });
          }
        }
      }
    }
  }
  
  return opportunities.sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit));
}

// ── AGENTS 1-6 ─────────────────────────────────────────────────────────────────
function agentValue(game) {
  const picks = [];
  
  if (game.spreadLines.length >= 2) {
    const bestHomePrice = Math.max(...game.spreadLines.map(l => l.homePrice));
    const bestAwayPrice = Math.max(...game.spreadLines.map(l => l.awayPrice));
    const avgHome = avg(game.spreadLines.map(l => l.homePrice));
    const avgAway = avg(game.spreadLines.map(l => l.awayPrice));
    
    const { side1: trueHome, side2: trueAway } = devig(avgHome, avgAway);
    const edgeHome = (trueHome - impliedProb(bestHomePrice)) * 100;
    const edgeAway = (trueAway - impliedProb(bestAwayPrice)) * 100;
    
    const homePoint = game.spreadLines[0].homePoint;
    const awayPoint = game.spreadLines[0].awayPoint;
    
    if (edgeHome > 2.5)
      picks.push({ side: "home", team: game.homeTeam, bet: `${game.homeTeam} ${homePoint > 0 ? "+" : ""}${homePoint}`, odds: fmtOdds(bestHomePrice), edge: edgeHome, market: "spread" });
    if (edgeAway > 2.5)
      picks.push({ side: "away", team: game.awayTeam, bet: `${game.awayTeam} ${awayPoint > 0 ? "+" : ""}${awayPoint}`, odds: fmtOdds(bestAwayPrice), edge: edgeAway, market: "spread" });
  }
  
  if (game.mlLines.length >= 2) {
    const bestAwayML = Math.max(...game.mlLines.map(l => l.awayPrice));
    const avgHomeML = avg(game.mlLines.map(l => l.homePrice));
    const avgAwayML = avg(game.mlLines.map(l => l.awayPrice));
    const { side2: trueAway } = devig(avgHomeML, avgAwayML);
    const edgeAwayML = (trueAway - impliedProb(bestAwayML)) * 100;
    
    if (edgeAwayML > 3.5 && bestAwayML > 110)
      picks.push({ side: "away", team: game.awayTeam, bet: `${game.awayTeam} ML`, odds: fmtOdds(bestAwayML), edge: edgeAwayML, market: "moneyline" });
  }
  
  return picks;
}

function agentLineMovement(game) {
  const signals = [];
  if (game.spreadLines.length < 2) return signals;
  
  const awayPoints = game.spreadLines.map(l => l.awayPoint);
  const lineSpread = Math.max(...awayPoints) - Math.min(...awayPoints);
  
  if (lineSpread >= 0.5) {
    const bestForAway = game.spreadLines.reduce((best, l) => l.awayPoint > best.awayPoint ? l : best);
    signals.push({
      side: game.awayTeam, market: "spread",
      bestLine: `${bestForAway.awayPoint > 0 ? "+" : ""}${bestForAway.awayPoint}`,
      spread: lineSpread,
      strength: lineSpread >= 1.5 ? "strong" : lineSpread >= 1 ? "moderate" : "weak",
    });
  }
  
  const sharpLines = game.spreadLines.filter(l => l.isSharp);
  const squareLines = game.spreadLines.filter(l => !l.isSharp);
  if (sharpLines.length && squareLines.length) {
    const sharpAvg = avg(sharpLines.map(l => l.awayPoint));
    const squareAvg = avg(squareLines.map(l => l.awayPoint));
    const diff = sharpAvg - squareAvg;
    if (Math.abs(diff) >= 0.5) {
      signals.push({
        side: diff > 0 ? game.awayTeam : game.homeTeam,
        market: "spread", type: "sharp_vs_square",
        diff: diff.toFixed(1),
        strength: Math.abs(diff) >= 1 ? "strong" : "moderate",
      });
    }
  }
  
  return signals;
}

function agentPublicMoney(game) {
  const signals = [];
  const squareSpread = game.spreadLines.filter(l => !l.isSharp);
  if (squareSpread.length) {
    const avgHomeJuice = avg(squareSpread.map(l => impliedProb(l.homePrice)));
    const avgAwayJuice = avg(squareSpread.map(l => impliedProb(l.awayPrice)));
    const publicIsHome = avgHomeJuice > avgAwayJuice;
    const heavierSidePct = Math.round(Math.max(avgHomeJuice, avgAwayJuice) * 100);
    const publicPct = Math.min(80, Math.max(55, heavierSidePct + 8));
    
    signals.push({
      market: "spread",
      publicSide: publicIsHome ? game.homeTeam : game.awayTeam,
      publicPct,
      contrarianSide: publicIsHome ? game.awayTeam : game.homeTeam,
      contrarianPct: 100 - publicPct,
    });
  }
  return signals;
}

function agentSharpMoney(game) {
  const signals = [];
  if (game.spreadLines.length < 2) return signals;
  
  const sharpLines = game.spreadLines.filter(l => l.isSharp);
  const squareLines = game.spreadLines.filter(l => !l.isSharp);
  
  if (sharpLines.length && squareLines.length) {
    const sharpAwayAvg = avg(sharpLines.map(l => l.awayPoint));
    const squareAwayAvg = avg(squareLines.map(l => l.awayPoint));
    const sharpHomeJuice = avg(sharpLines.map(l => l.homePrice));
    const squareHomeJuice = avg(squareLines.map(l => l.homePrice));
    
    if (sharpAwayAvg > squareAwayAvg + 0.5 && squareHomeJuice < sharpHomeJuice) {
      signals.push({
        type: "RLM", sharpSide: game.awayTeam, market: "spread",
        signal: "strong", rlmDetected: true,
        description: `Sharp books giving ${game.awayTeam} ${(sharpAwayAvg - squareAwayAvg).toFixed(1)} more points`,
      });
    }
  }
  
  const allHomeJuice = avg(game.spreadLines.map(l => impliedProb(l.homePrice)));
  const allAwayJuice = avg(game.spreadLines.map(l => impliedProb(l.awayPrice)));
  const juiceDiff = allHomeJuice - allAwayJuice;
  
  if (Math.abs(juiceDiff) > 0.04) {
    signals.push({
      type: "juice_imbalance",
      publicSide: juiceDiff > 0 ? game.homeTeam : game.awayTeam,
      sharpSide: juiceDiff > 0 ? game.awayTeam : game.homeTeam,
      market: "spread", rlmDetected: false,
      signal: Math.abs(juiceDiff) > 0.07 ? "strong" : "moderate",
      juiceDiff: (Math.abs(juiceDiff) * 100).toFixed(1),
    });
  }
  
  return signals;
}

function agentInjury(game) {
  const flags = [];
  
  if (game.injuries?.length > 0) {
    const highImpact = game.injuries.filter(i => i.impact === 'high');
    if (highImpact.length > 0) {
      flags.push({
        flag: `${highImpact.length} high-impact players OUT/Doubtful`,
        severity: "high",
        players: highImpact.map(i => i.player)
      });
    }
  }
  
  if (game.spreadLines.length) {
    const awayPoint = game.spreadLines[0].awayPoint;
    const homePrice = game.spreadLines[0].homePrice;
    
    if (awayPoint > 14)
      flags.push({ flag: `${game.awayTeam} large underdogs — verify roster`, severity: "check" });
    if (homePrice < -135)
      flags.push({ flag: "Heavy juice — may reflect injury news", severity: "moderate" });
  }
  
  return {
    game: game.game,
    flags: flags.length ? flags : [{ flag: "No significant injury concerns", severity: "none" }],
    lineImpact: flags.some(f => f.severity === 'high') ? "high_impact" : flags.length ? "check_reports" : "none",
  };
}

function agentSituational(game) {
  const edges = [];
  
  if (game.spreadLines.length) {
    const awayPoint = game.spreadLines[0].awayPoint;
    const homePoint = game.spreadLines[0].homePoint;
    
    if (awayPoint > 0) {
      edges.push({
        edge: "Road underdog spot",
        side: game.awayTeam, betType: "spread",
        strength: awayPoint > 6 ? "strong" : awayPoint > 3 ? "moderate" : "weak",
        note: "Road underdogs historically undervalued",
      });
    }
    if (homePoint < -9) {
      edges.push({
        edge: "Large home chalk fade",
        side: game.awayTeam, betType: "spread",
        strength: homePoint < -13 ? "moderate" : "weak",
        note: "Public inflates heavy home favorite lines",
      });
    }
  }
  
  if (game.mlLines.length) {
    const bestAwayML = Math.max(...game.mlLines.map(l => l.awayPrice));
    if (bestAwayML > 160) {
      edges.push({
        edge: "Big underdog ML value",
        side: game.awayTeam, betType: "moneyline", odds: fmtOdds(bestAwayML),
        strength: bestAwayML > 250 ? "moderate" : "weak",
        note: `Public undervalues ${game.awayTeam} at ${fmtOdds(bestAwayML)}`,
      });
    }
  }
  
  return edges;
}

// ── AGENT 7: CONSENSUS ────────────────────────────────────────────────────────
function agentConsensus(parsedGames) {
  const candidates = [];
  
  for (const game of parsedGames) {
    const valueSignals = agentValue(game);
    const lineSignals = agentLineMovement(game);
    const publicSignals = agentPublicMoney(game);
    const sharpSignals = agentSharpMoney(game);
    const injuryData = agentInjury(game);
    const situational = agentSituational(game);
    
    for (const vp of valueSignals) {
      let score = 0;
      score += Math.min(vp.edge * 4.5, 35);
      
      const lineMatch = lineSignals.find(l => l.side === vp.team);
      if (lineMatch) score += lineMatch.strength === "strong" ? 20 : lineMatch.strength === "moderate" ? 12 : 6;
      
      const pubSignal = publicSignals.find(p => p.market === vp.market);
      if (pubSignal && pubSignal.contrarianSide === vp.team)
        score += pubSignal.publicPct > 68 ? 20 : pubSignal.publicPct > 60 ? 13 : 7;
      
      const sharpMatch = sharpSignals.find(s => s.sharpSide === vp.team || (s.publicSide && s.publicSide !== vp.team));
      if (sharpMatch) {
        score += sharpMatch.signal === "strong" ? 22 : sharpMatch.signal === "moderate" ? 13 : 7;
        if (sharpMatch.rlmDetected) score += 5;
      }
      
      if (injuryData.lineImpact === "high_impact") score -= 15;
      else if (injuryData.lineImpact === "check_reports") score -= 10;
      
      const sitMatch = situational.find(s => s.side === vp.team);
      if (sitMatch) score += sitMatch.strength === "strong" ? 15 : sitMatch.strength === "moderate" ? 9 : 5;
      
      const confidence = Math.min(90, Math.max(55, Math.round(score * 0.65 + 20)));
      const edge = Math.max(0, Math.min(14, parseFloat((vp.edge * 0.88).toFixed(1))));
      
      if (confidence < 65 || edge < 3.5) continue;
      
      candidates.push({
        game, bet: vp.bet, betType: vp.betType,
        odds: vp.odds, confidence, edge, team: vp.team, score,
        timestamp: new Date().toISOString(),
        model_breakdown: {
          value: `${edge >= 9 ? "A" : edge >= 7 ? "A-" : "B+"} — ${edge.toFixed(1)}% edge`,
          line_movement: lineSignals.length > 0 ? lineSignals[0].strength : "stable",
          public_money: pubSignal ? `~${pubSignal.publicPct}% on ${pubSignal.publicSide}` : "Even",
          sharp_action: sharpSignals.length > 0 ? (sharpSignals[0].rlmDetected ? "RLM detected" : "Active") : "Quiet",
          injury_report: injuryData.flags[0].flag,
          situational: situational.length > 0 ? situational[0].edge : "Standard",
          best_book: game.spreadLines[0]?.book || "Multiple",
        },
      });
    }
  }
  
  candidates.sort((a, b) => b.score - a.score);
  const topPicks = candidates.slice(0, 10);
  
  // Store in history for analytics
  pickHistory.push(...topPicks.map(p => ({ ...p, storedAt: new Date().toISOString() })));
  
  return {
    consensus_picks: topPicks.map((c, i) => ({
      id: `${c.game.sport}_${Date.now()}_${i}`,
      sport: c.game.sport, emoji: c.game.emoji,
      game: c.game.game,
      bet: c.bet, betType: c.betType, odds: c.odds,
      confidence: c.confidence, edge: c.edge,
      timestamp: c.timestamp,
      model_breakdown: c.model_breakdown,
    })),
  };
}

// ── CHAT KB ────────────────────────────────────────────────────────────────────
const CHAT_KB = [
  { keys: ["kelly", "sizing", "bankroll"], reply: "Kelly Criterion: stake = (edge% × bankroll) ÷ decimal odds. Use ¼ Kelly (1-2% per play) to survive variance." },
  { keys: ["parlay", "multi-leg"], reply: "Parlays compound house edge. Use 2-3 legs max, only when correlated. Avoid 4+ legs." },
  { keys: ["rlm", "reverse line"], reply: "RLM: 70%+ public on one side, but line moves the other way = sharp money signal." },
  { keys: ["clv", "closing line"], reply: "CLV is the gold standard. Beat the closing line = long-term profit." },
  { keys: ["arb", "arbitrage"], reply: "Arbitrage = bet both sides at different books for guaranteed profit. Check the Arbs tab!" },
  { keys: ["prop", "player"], reply: "Player props are softer markets. We scan them with 7-agent analysis." },
];

function chatResponse(message) {
  const lower = message.toLowerCase();
  for (const entry of CHAT_KB) {
    if (entry.keys.some(k => lower.includes(k))) return entry.reply;
  }
  return "Hit Scan to find +EV picks. The 7-agent system analyzes value, line movement, sharp money, and situational edges.";
}

// ── DISCORD WEBHOOK ────────────────────────────────────────────────────────────
async function sendDiscordAlert(picks, webhookUrl) {
  if (!webhookUrl || picks.length === 0) return;
  
  const embeds = picks.slice(0, 5).map(pick => ({
    title: `${pick.emoji} ${pick.bet}`,
    description: `${pick.game}\n**${pick.odds}** | ${pick.confidence}% confidence | +${pick.edge}% edge`,
    color: pick.confidence >= 75 ? 0x22d3ee : 0xa78bfa,
    fields: [
      { name: "Value", value: pick.model_breakdown?.value?.split(' ')[0] || "B+", inline: true },
      { name: "Sharp", value: pick.model_breakdown?.sharp_action === "RLM detected" ? "✅ RLM" : "Active", inline: true },
      { name: "Best Book", value: pick.model_breakdown?.best_book || "Multiple", inline: true },
    ],
    timestamp: new Date().toISOString(),
  }));
  
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🔥 ${picks.length} New High-Confidence Picks`,
        embeds,
      }),
    });
  } catch (e) {
    console.error("Discord webhook failed:", e.message);
  }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({ status: "ok", service: "EdgeBet AI API v3.0", agents: 7, features: ["picks", "props", "arbitrage", "injuries", "analytics", "discord"], version: "3.0.0" })
);

// User authentication
app.post("/auth/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  
  const userId = `user_${Date.now()}`;
  users.set(email, { id: userId, email, password, preferences: {}, createdAt: new Date() });
  
  res.json({ userId, email, token: `token_${userId}` });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = users.get(email);
  if (!user || user.password !== password) return res.status(401).json({ error: "Invalid credentials" });
  
  res.json({ userId: user.id, email, token: `token_${user.id}` });
});

// Main scan endpoint
app.get("/scan", async (req, res) => {
  try {
    // Fetch injuries for all sports in parallel
    const injuryPromises = SPORTS.map(s => 
      s.sportsdataSport ? fetchInjuries(s.sportsdataSport) : Promise.resolve([])
    );
    const injuriesBySport = await Promise.all(injuryPromises);
    
    const oddsResults = await Promise.all(
      SPORTS.map((s, i) =>
        fetchSportOdds(s.key).then(games =>
          games.slice(0, 8).map(g => parseGame(g, s.label, s.emoji, injuriesBySport[i]))
        )
      )
    );

    const allGames = oddsResults.flat();
    if (allGames.length === 0) {
      return res.status(503).json({ error: "No odds data available" });
    }

    const arbs = detectArbitrage(allGames);
    const result = agentConsensus(allGames);
    
    // Send Discord alert if high-confidence picks exist
    const highConfPicks = result.consensus_picks.filter(p => p.confidence >= 75);
    if (highConfPicks.length > 0 && process.env.DISCORD_WEBHOOK_URL) {
      sendDiscordAlert(highConfPicks, process.env.DISCORD_WEBHOOK_URL);
    }
    
    console.log(`Scan: ${result.consensus_picks.length} picks, ${arbs.length} arbs`);
    res.json({ ...result, arbitrage_opportunities: arbs.slice(0, 5) });
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analytics endpoint
app.get("/analytics", (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  const recentPicks = pickHistory.filter(p => new Date(p.timestamp) > cutoff);
  
  const bySport = {};
  const byAgent = {};
  let totalEdge = 0;
  
  for (const pick of recentPicks) {
    bySport[pick.game.sport] = (bySport[pick.game.sport] || 0) + 1;
    totalEdge += pick.edge;
    
    // Track by agent contributions
    if (pick.model_breakdown?.value?.startsWith('A')) byAgent.value = (byAgent.value || 0) + 1;
    if (pick.model_breakdown?.sharp_action?.includes('RLM')) byAgent.sharp = (byAgent.sharp || 0) + 1;
  }
  
  res.json({
    totalPicks: recentPicks.length,
    avgEdge: recentPicks.length > 0 ? (totalEdge / recentPicks.length).toFixed(2) : 0,
    bySport,
    byAgent,
    highConfidencePicks: recentPicks.filter(p => p.confidence >= 75).length,
  });
});

// Props endpoint
app.get("/props", async (req, res) => {
  try {
    const sport = req.query.sport || "basketball_nba";
    const propsData = await fetchPlayerProps(sport);
    
    const allProps = [];
    for (const gameData of propsData) {
      const sportInfo = SPORTS.find(s => s.key === sport);
      const props = parseProps(gameData, sportInfo?.label || "NBA", sportInfo?.emoji || "🏀");
      allProps.push(...props);
    }
    
    const analyzedProps = allProps
      .filter(p => p.books.length >= 2)
      .map(p => {
        const prices = p.books.map(b => b.price);
        const avgPrice = avg(prices);
        const bestPrice = Math.max(...prices);
        const edge = Math.abs((impliedProb(avgPrice) - impliedProb(bestPrice)) * 100);
        
        return {
          ...p,
          edge: edge.toFixed(1),
          confidence: Math.min(85, 55 + edge * 2),
          model_breakdown: {
            value: edge > 3 ? "B+" : "B",
            line_movement: `${p.books.length} books`,
            best_book: p.books.find(b => b.price === bestPrice)?.book || "Multiple",
          }
        };
      })
      .sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge))
      .slice(0, 10);
    
    res.json({ props: analyzedProps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Arbitrage endpoint
app.get("/arbitrage", async (req, res) => {
  try {
    const oddsResults = await Promise.all(
      SPORTS.map(s =>
        fetchSportOdds(s.key).then(games =>
          games.slice(0, 6).map(g => parseGame(g, s.label, s.emoji))
        )
      )
    );

    const allGames = oddsResults.flat();
    const arbs = detectArbitrage(allGames);
    
    res.json({ 
      opportunities: arbs.slice(0, 10),
      count: arbs.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Injuries endpoint
app.get("/injuries/:sport", async (req, res) => {
  const sport = req.params.sport;
  const injuries = await fetchInjuries(sport);
  res.json({ sport, injuries: injuries.slice(0, 20), count: injuries.length });
});

// Chat endpoint
app.post("/chat", (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });
  res.json({ reply: chatResponse(message) });
});

// Push notification subscription
app.post("/subscribe-push", async (req, res) => {
  const { subscription, userId, preferences } = req.body;
  
  // Store in Redis for later use
  if (userId) {
    await redis.setEx(`push:${userId}`, 86400 * 30, JSON.stringify({
      subscription,
      preferences: preferences || { lineAlerts: true, highEdge: true, arbAlerts: true },
      subscribedAt: new Date().toISOString(),
    }));
  }
  
  res.json({ success: true });
});

// Discord webhook test
app.post("/discord/test", async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: "webhookUrl required" });
  
  try {
    await sendDiscordAlert([{
      emoji: "🧪",
      bet: "Test Pick",
      game: "Test Game",
      odds: "-110",
      confidence: 80,
      edge: 5.5,
      model_breakdown: { value: "A", sharp_action: "RLM detected", best_book: "TestBook" }
    }], webhookUrl);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`EdgeBet AI API v3.0 on :${PORT} — Redis, Analytics, Discord, Injuries`)
);
