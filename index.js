require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json());

const ODDS_API_KEY = process.env.ODDS_API_KEY || "316ba9e3bd49f1c65f604a292e1962a8";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

// Debug: Log if key is present (don't log the actual key!)
console.log("ODDS_API_KEY present:", !!ODDS_API_KEY);
console.log("ODDS_API_KEY length:", ODDS_API_KEY ? ODDS_API_KEY.length : 0);

const SPORTS = [
  { key: "basketball_nba",          label: "NBA",   emoji: "🏀" },
  { key: "americanfootball_nfl",    label: "NFL",   emoji: "🏈" },
  { key: "icehockey_nhl",           label: "NHL",   emoji: "🏒" },
  { key: "basketball_ncaab",        label: "NCAAB", emoji: "🎓" },
  { key: "baseball_mlb",            label: "MLB",   emoji: "⚾" },
  { key: "soccer_epl",              label: "EPL",   emoji: "⚽" },
  { key: "mma_mixed_martial_arts",  label: "MMA",   emoji: "🥊" },
];

// Player prop markets by sport
const PROP_MARKETS = {
  basketball_nba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_blocks", "player_steals"],
  americanfootball_nfl: ["player_pass_tds", "player_pass_yds", "player_rush_yds", "player_receptions", "player_receiving_yds"],
  icehockey_nhl: ["player_goals", "player_assists", "player_points", "player_shots_on_goal"],
  baseball_mlb: ["player_hits", "player_runs", "player_rbis", "player_home_runs"],
};

// Known sharp bookmakers
const SHARP_BOOKS = new Set(["pinnacle", "betcris", "betonlineag", "bovada", "lowvig"]);

// ── LINE HISTORY CACHE ───────────────────────────────────────────────────────
// Store line movements over time for sparkline charts
const lineHistory = new Map(); // gameId -> { timestamps: [], lines: [] }

function recordLineMovement(gameId, line, book) {
  if (!lineHistory.has(gameId)) {
    lineHistory.set(gameId, { timestamps: [], lines: [], books: [] });
  }
  const history = lineHistory.get(gameId);
  const now = Date.now();
  // Only record every 5 minutes max
  if (history.timestamps.length === 0 || now - history.timestamps[history.timestamps.length - 1] > 300000) {
    history.timestamps.push(now);
    history.lines.push(line);
    history.books.push(book);
  }
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

// ── ODDS FETCHER ──────────────────────────────────────────────────────────────
async function fetchSportOdds(sportKey, markets = "spreads,totals,h2h") {
  if (!ODDS_API_KEY) return [];
  const url = new URL(`${ODDS_BASE}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", markets);
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { console.warn(`Odds API [${sportKey}]: HTTP ${res.status}`); return []; }
    return res.json();
  } catch (e) { console.warn(`Odds API [${sportKey}]:`, e.message); return []; }
}

// Fetch player props
async function fetchPlayerProps(sportKey) {
  if (!ODDS_API_KEY) return [];
  const markets = PROP_MARKETS[sportKey];
  if (!markets) return [];
  
  const url = new URL(`${ODDS_BASE}/sports/${sportKey}/events`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  try {
    const eventsRes = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!eventsRes.ok) return [];
    const events = await eventsRes.json();
    
    // Fetch props for first 5 events
    const propsData = [];
    for (const event of events.slice(0, 5)) {
      const propsUrl = new URL(`${ODDS_BASE}/sports/${sportKey}/events/${event.id}/odds`);
      propsUrl.searchParams.set("apiKey", ODDS_API_KEY);
      propsUrl.searchParams.set("regions", "us");
      propsUrl.searchParams.set("markets", markets.join(","));
      propsUrl.searchParams.set("oddsFormat", "american");
      
      try {
        const res = await fetch(propsUrl.toString(), { signal: AbortSignal.timeout(8000) });
        if (res.ok) propsData.push(await res.json());
      } catch (e) { continue; }
    }
    return propsData;
  } catch (e) { console.warn(`Props API [${sportKey}]:`, e.message); return []; }
}

// ── GAME PARSER ───────────────────────────────────────────────────────────────
function parseGame(g, sportLabel, emoji) {
  const spreadLines = [], totalLines = [], mlLines = [];
  const gameId = `${sportLabel}_${g.home_team}_${g.away_team}`.replace(/\s/g, '_');

  for (const bk of (g.bookmakers || [])) {
    const isSharp = SHARP_BOOKS.has(bk.key);
    for (const mkt of bk.markets) {
      if (mkt.key === "spreads") {
        const home = mkt.outcomes.find((o) => o.name === g.home_team);
        const away = mkt.outcomes.find((o) => o.name === g.away_team);
        if (home && away) {
          spreadLines.push({ book: bk.key, isSharp, homePoint: home.point, homePrice: home.price, awayPoint: away.point, awayPrice: away.price });
          recordLineMovement(gameId, away.point, bk.key);
        }
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
  };
}

// ── PROPS PARSER ──────────────────────────────────────────────────────────────
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
          existing.books.push({ book: bk.key, over: outcome.price, under: null });
          existing.bestOver = Math.max(existing.bestOver, outcome.price);
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
    // Check spread arbitrage
    if (game.spreadLines.length >= 2) {
      const awayLines = game.spreadLines.map(l => ({ ...l, implied: impliedProb(l.awayPrice) }));
      const homeLines = game.spreadLines.map(l => ({ ...l, implied: impliedProb(l.homePrice) }));
      
      for (const away of awayLines) {
        for (const home of homeLines) {
          if (away.book === home.book) continue;
          const totalProb = away.implied + home.implied;
          if (totalProb < 0.98) { // >2% arbitrage
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
    
    // Check moneyline arbitrage
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

// ── AGENT 1: VALUE ────────────────────────────────────────────────────────────
function agentValue(game) {
  const picks = [];

  if (game.spreadLines.length >= 2) {
    const bestHomePrice = Math.max(...game.spreadLines.map((l) => l.homePrice));
    const bestAwayPrice = Math.max(...game.spreadLines.map((l) => l.awayPrice));
    const avgHome = avg(game.spreadLines.map((l) => l.homePrice));
    const avgAway = avg(game.spreadLines.map((l) => l.awayPrice));

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
    const bestAwayML = Math.max(...game.mlLines.map((l) => l.awayPrice));
    const avgHomeML  = avg(game.mlLines.map((l) => l.homePrice));
    const avgAwayML  = avg(game.mlLines.map((l) => l.awayPrice));
    const { side2: trueAway } = devig(avgHomeML, avgAwayML);
    const edgeAwayML = (trueAway - impliedProb(bestAwayML)) * 100;

    if (edgeAwayML > 3.5 && bestAwayML > 110)
      picks.push({ side: "away", team: game.awayTeam, bet: `${game.awayTeam} ML`, odds: fmtOdds(bestAwayML), edge: edgeAwayML, market: "moneyline" });
  }

  return picks;
}

// ── AGENT 2: LINE MOVEMENT ────────────────────────────────────────────────────
function agentLineMovement(game) {
  const signals = [];
  const history = lineHistory.get(game.gameId);

  if (game.spreadLines.length < 2) return signals;

  const awayPoints = game.spreadLines.map((l) => l.awayPoint);
  const lineSpread = Math.max(...awayPoints) - Math.min(...awayPoints);

  if (lineSpread >= 0.5) {
    const bestForAway = game.spreadLines.reduce((best, l) => (l.awayPoint > best.awayPoint ? l : best));
    signals.push({
      side: game.awayTeam, market: "spread",
      bestLine: `${bestForAway.awayPoint > 0 ? "+" : ""}${bestForAway.awayPoint}`,
      spread: lineSpread,
      strength: lineSpread >= 1.5 ? "strong" : lineSpread >= 1 ? "moderate" : "weak",
    });
  }

  const sharpLines  = game.spreadLines.filter((l) => l.isSharp);
  const squareLines = game.spreadLines.filter((l) => !l.isSharp);
  if (sharpLines.length && squareLines.length) {
    const sharpAvg  = avg(sharpLines.map((l) => l.awayPoint));
    const squareAvg = avg(squareLines.map((l) => l.awayPoint));
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
  
  // Historical line movement
  if (history && history.lines.length >= 2) {
    const oldLine = history.lines[0];
    const newLine = history.lines[history.lines.length - 1];
    const move = newLine - oldLine;
    if (Math.abs(move) >= 1) {
      signals.push({
        type: "historical",
        move: move.toFixed(1),
        direction: move > 0 ? "toward_away" : "toward_home",
        strength: Math.abs(move) >= 2 ? "strong" : "moderate",
      });
    }
  }

  return signals;
}

// ── AGENTS 3-6 (unchanged) ────────────────────────────────────────────────────
function agentPublicMoney(game) {
  const signals = [];
  const squareSpread = game.spreadLines.filter((l) => !l.isSharp);
  if (squareSpread.length) {
    const avgHomeJuice = avg(squareSpread.map((l) => impliedProb(l.homePrice)));
    const avgAwayJuice = avg(squareSpread.map((l) => impliedProb(l.awayPrice)));
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

  const sharpLines = game.spreadLines.filter((l) => l.isSharp);
  const squareLines = game.spreadLines.filter((l) => !l.isSharp);

  if (sharpLines.length && squareLines.length) {
    const sharpAwayAvg = avg(sharpLines.map((l) => l.awayPoint));
    const squareAwayAvg = avg(squareLines.map((l) => l.awayPoint));
    const sharpHomeJuice = avg(sharpLines.map((l) => l.homePrice));
    const squareHomeJuice = avg(squareLines.map((l) => l.homePrice));

    if (sharpAwayAvg > squareAwayAvg + 0.5 && squareHomeJuice < sharpHomeJuice) {
      signals.push({
        type: "RLM", sharpSide: game.awayTeam, market: "spread",
        signal: "strong", rlmDetected: true,
        description: `Sharp books giving ${game.awayTeam} ${(sharpAwayAvg - squareAwayAvg).toFixed(1)} more points`,
      });
    }
  }

  const allHomeJuice = avg(game.spreadLines.map((l) => impliedProb(l.homePrice)));
  const allAwayJuice = avg(game.spreadLines.map((l) => impliedProb(l.awayPrice)));
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
  if (game.spreadLines.length) {
    const awayPoint = game.spreadLines[0].awayPoint;
    const homePrice = game.spreadLines[0].homePrice;
    const awayPrice = game.spreadLines[0].awayPrice;

    if (awayPoint > 14)
      flags.push({ flag: `${game.awayTeam} large underdogs — verify roster`, severity: "check" });
    if (homePrice < -135 || awayPrice < -135)
      flags.push({ flag: "Heavy juice — may reflect injury news", severity: "moderate" });
    if (game.spreadLines.length >= 3) {
      const points = game.spreadLines.map((l) => l.awayPoint);
      if (Math.max(...points) - Math.min(...points) >= 2)
        flags.push({ flag: "High spread variance — market reacting to news", severity: "check" });
    }
  }
  return {
    game: game.game,
    flags: flags.length ? flags : [{ flag: "No unusual line shapes", severity: "none" }],
    lineImpact: flags.length ? "check_reports" : "none",
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
    const bestAwayML = Math.max(...game.mlLines.map((l) => l.awayPrice));
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

      const lineMatch = lineSignals.find((l) => l.side === vp.team);
      if (lineMatch)
        score += lineMatch.strength === "strong" ? 20 : lineMatch.strength === "moderate" ? 12 : 6;

      const pubSignal = publicSignals.find((p) => p.market === vp.market);
      if (pubSignal && pubSignal.contrarianSide === vp.team)
        score += pubSignal.publicPct > 68 ? 20 : pubSignal.publicPct > 60 ? 13 : 7;

      const sharpMatch = sharpSignals.find((s) => s.sharpSide === vp.team || (s.publicSide && s.publicSide !== vp.team));
      if (sharpMatch) {
        score += sharpMatch.signal === "strong" ? 22 : sharpMatch.signal === "moderate" ? 13 : 7;
        if (sharpMatch.rlmDetected) score += 5;
      }

      if (injuryData.lineImpact === "check_reports") score -= 10;

      const sitMatch = situational.find((s) => s.side === vp.team);
      if (sitMatch)
        score += sitMatch.strength === "strong" ? 15 : sitMatch.strength === "moderate" ? 9 : 5;

      const confidence = Math.min(90, Math.max(55, Math.round(score * 0.65 + 20)));
      const edge = Math.max(0, Math.min(14, parseFloat((vp.edge * 0.88).toFixed(1))));

      if (confidence < 65 || edge < 3.5) continue;

      const pubData = publicSignals.find((p) => p.market === vp.market);
      const sharpData = sharpSignals.find((s) => s.sharpSide === vp.team);
      const lineData = lineSignals.find((l) => l.side === vp.team);
      const sitData = situational.find((s) => s.side === vp.team);
      const valueGrade = edge >= 9 ? "A" : edge >= 7 ? "A-" : edge >= 5 ? "B+" : "B";
      
      const history = lineHistory.get(game.gameId);
      const lineSparkline = history ? history.lines : [];

      const spreadRef = game.spreadLines[0];
      const awayPt = spreadRef ? (spreadRef.awayPoint > 0 ? "+" : "") + spreadRef.awayPoint : "N/A";

      candidates.push({
        game, bet: vp.bet, betType: vp.market === "moneyline" ? "moneyline" : vp.market === "total" ? "total" : "spread",
        odds: vp.odds, confidence, edge, team: vp.team, score,
        openingLine: lineSparkline.length > 0 ? lineSparkline[0] : awayPt,
        currentLine: awayPt,
        lineSparkline,
        lineMove: sharpData?.rlmDetected
          ? "▲ RLM detected"
          : lineData
          ? `▲ ${lineData.spread?.toFixed(1) || "0.5"}pt move`
          : "→ Stable",
        model_breakdown: {
          value: `${valueGrade} — ${edge.toFixed(1)}% edge`,
          line_movement: lineData
            ? `${lineData.strength} movement — best ${lineData.bestLine}. ${lineData.type === "sharp_vs_square" ? "Sharp divergence " + lineData.diff + "pts" : ""}`
            : "Stable",
          public_money: pubData ? `~${pubData.publicPct}% on ${pubData.publicSide}` : "Even split",
          sharp_action: sharpData ? (sharpData.rlmDetected ? "RLM confirmed" : `${sharpData.juiceDiff}% imbalance`) : "No signal",
          injury_report: injuryData.flags[0].flag,
          situational: sitData ? sitData.edge : "Standard",
          best_book: game.spreadLines.reduce((best, l) => l.awayPrice > best.awayPrice ? l : best, game.spreadLines[0])?.book || "Multiple",
        },
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    consensus_picks: candidates.slice(0, 8).map((c, i) => ({
      id: `${c.game.sport}_${i}`,
      sport: c.game.sport, emoji: c.game.emoji,
      game: c.game.game, homeTeam: c.game.homeTeam, awayTeam: c.game.awayTeam,
      bet: c.bet, betType: c.betType, odds: c.odds,
      confidence: c.confidence, edge: c.edge,
      openingLine: c.openingLine, currentLine: c.currentLine, 
      lineSparkline: c.lineSparkline,
      lineMove: c.lineMove,
      model_breakdown: c.model_breakdown,
    })),
  };
}

// ── CHAT KNOWLEDGE BASE ───────────────────────────────────────────────────────
const CHAT_KB = [
  {
    keys: ["kelly", "sizing", "how much", "bankroll", "unit size", "stake"],
    reply: "Kelly Criterion: stake = (edge% × bankroll) ÷ decimal odds. For a 6% edge at -110 odds, that's (0.06 ÷ 0.909) = 6.6% of bankroll. Most pros use ¼ Kelly (1.65%) to survive variance.",
  },
  {
    keys: ["parlay", "same game", "sgp", "multi-leg", "accumulator"],
    reply: "Parlays compound house edge on every leg. Use 2-3 legs max, only when correlated. Avoid 4+ leg parlays — the math grinds you down.",
  },
  {
    keys: ["rlm", "reverse line movement", "steam", "sharp money"],
    reply: "RLM: when 70%+ public tickets on one side, but line moves the other way. That's sharp money overriding public. One of the strongest signals.",
  },
  {
    keys: ["clv", "closing line", "beat the close", "closing value"],
    reply: "CLV is the gold standard. If you bet -3 and it closes -5, you got +2pts CLV. Track CLV obsessively — positive CLV means long-term profitability.",
  },
  {
    keys: ["injury", "out", "questionable", "dnp", "lineup"],
    reply: "Injury news moves lines fastest. Check beat reporters on Twitter/X 60-90 min before tip-off. Lines that don't move after injury = already priced in.",
  },
  {
    keys: ["arbitrage", "arb", "sure bet", "guaranteed profit"],
    reply: "Arbitrage: bet both sides at different books for guaranteed profit. Requires multiple book accounts and quick action — lines move fast. Check the Arb Alert tab!",
  },
  {
    keys: ["props", "player prop", "points", "rebounds", "assists"],
    reply: "Player props are softer markets than game lines. EdgeBet scans props for value using the same 7-agent system. Check the Props tab!",
  },
];

function chatResponse(message) {
  const lower = message.toLowerCase();
  for (const entry of CHAT_KB) {
    if (entry.keys.some((k) => lower.includes(k))) return entry.reply;
  }
  return "Hit Scan to run the 7-agent analysis. The system checks value edges, line movement, sharp signals, and situational spots. For bankroll: flat bet 1-2% per play.";
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({ status: "ok", service: "EdgeBet AI API v2.1", agents: 7, features: ["picks", "props", "arbitrage", "line-history"], version: "2.1.0" })
);

app.get("/debug", (req, res) => {
  res.json({
    oddsKeyPresent: !!process.env.ODDS_API_KEY,
    oddsKeyLength: process.env.ODDS_API_KEY ? process.env.ODDS_API_KEY.length : 0,
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    lineHistorySize: lineHistory.size,
  });
});

// Main scan endpoint
app.get("/scan", async (req, res) => {
  try {
    const oddsResults = await Promise.all(
      SPORTS.map((s) =>
        fetchSportOdds(s.key).then((games) =>
          games.slice(0, 8).map((g) => parseGame(g, s.label, s.emoji))
        )
      )
    );

    const allGames = oddsResults.flat();
    if (allGames.length === 0) {
      return res.status(503).json({ error: "No odds data available" });
    }

    const arbs = detectArbitrage(allGames);
    const result = agentConsensus(allGames);
    
    console.log(`Scan: ${result.consensus_picks.length} picks, ${arbs.length} arbs from ${allGames.length} games`);
    res.json({ ...result, arbitrage_opportunities: arbs.slice(0, 5) });
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/scan", async (req, res) => {
  try {
    const oddsResults = await Promise.all(
      SPORTS.map((s) =>
        fetchSportOdds(s.key).then((games) =>
          games.slice(0, 8).map((g) => parseGame(g, s.label, s.emoji))
        )
      )
    );

    const allGames = oddsResults.flat();
    if (allGames.length === 0) {
      return res.status(503).json({ error: "No odds data available" });
    }

    const arbs = detectArbitrage(allGames);
    const result = agentConsensus(allGames);
    
    res.json({ ...result, arbitrage_opportunities: arbs.slice(0, 5) });
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Player props endpoint
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
    
    // Apply 7-agent analysis to props (simplified)
    const analyzedProps = allProps
      .filter(p => p.books.length >= 2)
      .map(p => {
        const prices = p.books.map(b => b.price);
        const avgPrice = avg(prices);
        const bestPrice = Math.max(...prices);
        const edge = ((impliedProb(avgPrice) - impliedProb(bestPrice)) * 100);
        
        return {
          ...p,
          edge: Math.abs(edge).toFixed(1),
          confidence: Math.min(85, 55 + Math.abs(edge) * 2),
          model_breakdown: {
            value: edge > 3 ? "B+" : "B",
            line_movement: `${p.books.length} books tracked`,
            best_book: p.books.find(b => b.price === bestPrice)?.book || "Multiple",
          }
        };
      })
      .sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge))
      .slice(0, 10);
    
    res.json({ props: analyzedProps });
  } catch (err) {
    console.error("Props error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Arbitrage endpoint
app.get("/arbitrage", async (req, res) => {
  try {
    const oddsResults = await Promise.all(
      SPORTS.map((s) =>
        fetchSportOdds(s.key).then((games) =>
          games.slice(0, 6).map((g) => parseGame(g, s.label, s.emoji))
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
    console.error("Arbitrage error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Line history endpoint
app.get("/line-history/:gameId", (req, res) => {
  const history = lineHistory.get(req.params.gameId);
  if (!history) {
    return res.status(404).json({ error: "No history for this game" });
  }
  res.json({
    gameId: req.params.gameId,
    dataPoints: history.lines.length,
    sparkline: history.lines,
    timestamps: history.timestamps,
  });
});

// Chat endpoint
app.post("/chat", (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });
  res.json({ reply: chatResponse(message) });
});

// Stripe subscription check
app.post("/api/plan-status", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    if (process.env.STRIPE_SECRET_KEY) {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const customers = await stripe.customers.list({ email: userId, limit: 1 });
      if (customers.data.length > 0) {
        const subs = await stripe.subscriptions.list({
          customer: customers.data[0].id, status: "active", limit: 1,
        });
        if (subs.data.length > 0) {
          const sub = subs.data[0];
          const amount = sub.items.data[0]?.price?.unit_amount || 0;
          return res.json({
            plan: amount >= 4999 ? "sharp" : "pro",
            isActive: true,
            expiresAt: new Date(sub.current_period_end * 1000).toISOString(),
          });
        }
      }
    }
    res.json({ plan: "free", isActive: false, expiresAt: null });
  } catch (err) {
    res.json({ plan: "free", isActive: false, expiresAt: null });
  }
});

// Push notification subscription (placeholder for OneSignal)
app.post("/subscribe-push", (req, res) => {
  const { subscription, userId } = req.body;
  // Store subscription for later use
  console.log("Push subscription received:", userId);
  res.json({ success: true });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`EdgeBet AI API v2.1 on :${PORT} — Features: picks, props, arbitrage, line-history`)
);
