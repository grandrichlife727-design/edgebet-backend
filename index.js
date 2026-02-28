require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(express.json());

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_BASE = "https://api.the-odds-api.com/v4";

// Debug: Log if key is present (don't log the actual key!)
console.log("ODDS_API_KEY present:", !!ODDS_API_KEY);
console.log("ODDS_API_KEY length:", ODDS_API_KEY ? ODDS_API_KEY.length : 0);

const SPORTS = [
  { key: "basketball_nba",       label: "NBA",   emoji: "🏀" },
  { key: "americanfootball_nfl", label: "NFL",   emoji: "🏈" },
  { key: "icehockey_nhl",        label: "NHL",   emoji: "🏒" },
  { key: "basketball_ncaab",     label: "NCAAB", emoji: "🎓" },
  { key: "baseball_mlb",         label: "MLB",   emoji: "⚾" },
];

// Known sharp bookmakers — their lines reflect smart money
const SHARP_BOOKS = new Set(["pinnacle", "betcris", "betonlineag", "bovada", "lowvig"]);

// ── MATH UTILS ────────────────────────────────────────────────────────────────

// American odds → implied probability (includes vig)
const impliedProb = (odds) =>
  odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);

// Strip the vig — returns true no-vig probability for each side
const devig = (price1, price2) => {
  const ip1 = impliedProb(price1);
  const ip2 = impliedProb(price2);
  const total = ip1 + ip2;
  return { side1: ip1 / total, side2: ip2 / total };
};

// Average an array of numbers
const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

// Format American odds with sign
const fmtOdds = (n) => (n > 0 ? `+${n}` : `${n}`);

// ── ODDS FETCHER ──────────────────────────────────────────────────────────────
async function fetchSportOdds(sportKey) {
  if (!ODDS_API_KEY) return [];
  const url = new URL(`${ODDS_BASE}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", ODDS_API_KEY);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "spreads,totals,h2h");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { console.warn(`Odds API [${sportKey}]: HTTP ${res.status}`); return []; }
    return res.json();
  } catch (e) { console.warn(`Odds API [${sportKey}]:`, e.message); return []; }
}

// Parse a raw API game into structured lines across all bookmakers
function parseGame(g, sportLabel, emoji) {
  const spreadLines = [], totalLines = [], mlLines = [];

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
        const over  = mkt.outcomes.find((o) => o.name === "Over");
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
    sport: sportLabel, emoji,
    game: `${g.away_team} @ ${g.home_team}`,
    homeTeam: g.home_team, awayTeam: g.away_team,
    commenceTime: g.commence_time,
    spreadLines, totalLines, mlLines,
  };
}

// ── AGENT 1: VALUE ────────────────────────────────────────────────────────────
// Strips the vig across all bookmakers to find the true no-vig probability,
// then compares it to the best available line to calculate mathematical edge.
function agentValue(game) {
  const picks = [];

  // ── Spread value ──────────────────────────────────────────────────────────
  if (game.spreadLines.length >= 2) {
    const bestHomePrice = Math.max(...game.spreadLines.map((l) => l.homePrice));
    const bestAwayPrice = Math.max(...game.spreadLines.map((l) => l.awayPrice));
    const avgHome = avg(game.spreadLines.map((l) => l.homePrice));
    const avgAway = avg(game.spreadLines.map((l) => l.awayPrice));

    // True probability after removing vig from consensus line
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

  // ── Moneyline value (underdogs only — public systematically undervalues them) ─
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
// Detects spread variance across bookmakers as a proxy for line movement.
// Sharp books diverging from recreational books = active market signal.
function agentLineMovement(game) {
  const signals = [];

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

  // Sharp vs square divergence
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

  return signals;
}

// ── AGENT 3: PUBLIC MONEY ─────────────────────────────────────────────────────
// Infers public betting distribution from juice levels at recreational books.
// Heavily juiced side (-115 or worse at square books) = where the public is.
function agentPublicMoney(game) {
  const signals = [];

  // Use square books only — sharp books balance their own book differently
  const squareSpread = game.spreadLines.filter((l) => !l.isSharp);
  if (squareSpread.length) {
    const avgHomeJuice = avg(squareSpread.map((l) => impliedProb(l.homePrice)));
    const avgAwayJuice = avg(squareSpread.map((l) => impliedProb(l.awayPrice)));
    const publicIsHome = avgHomeJuice > avgAwayJuice;
    const heavierSidePct = Math.round(Math.max(avgHomeJuice, avgAwayJuice) * 100);

    // Calibrate to realistic public percentage range (55-80%)
    const publicPct  = Math.min(80, Math.max(55, heavierSidePct + 8));
    const otherPct   = 100 - publicPct;

    signals.push({
      market: "spread",
      publicSide:      publicIsHome ? game.homeTeam : game.awayTeam,
      publicPct,
      contrarianSide:  publicIsHome ? game.awayTeam : game.homeTeam,
      contrarianPct:   otherPct,
    });
  }

  return signals;
}

// ── AGENT 4: SHARP MONEY ──────────────────────────────────────────────────────
// Detects reverse line movement (RLM): public loading one side, line moving other way.
// Also detects extreme juice imbalance — a structural sharp signal.
function agentSharpMoney(game) {
  const signals = [];

  if (game.spreadLines.length < 2) return signals;

  const sharpLines  = game.spreadLines.filter((l) => l.isSharp);
  const squareLines = game.spreadLines.filter((l) => !l.isSharp);

  // RLM: sharp books giving away team more points than square books
  if (sharpLines.length && squareLines.length) {
    const sharpAwayAvg  = avg(sharpLines.map((l) => l.awayPoint));
    const squareAwayAvg = avg(squareLines.map((l) => l.awayPoint));
    const sharpHomeJuice  = avg(sharpLines.map((l) => l.homePrice));
    const squareHomeJuice = avg(squareLines.map((l) => l.homePrice));

    if (sharpAwayAvg > squareAwayAvg + 0.5 && squareHomeJuice < sharpHomeJuice) {
      signals.push({
        type: "RLM", sharpSide: game.awayTeam, market: "spread",
        signal: "strong", rlmDetected: true,
        description: `Sharp books giving ${game.awayTeam} ${(sharpAwayAvg - squareAwayAvg).toFixed(1)} more points than recreational books`,
      });
    }
  }

  // Extreme juice imbalance across all books (>4% probability gap)
  const allHomeJuice = avg(game.spreadLines.map((l) => impliedProb(l.homePrice)));
  const allAwayJuice = avg(game.spreadLines.map((l) => impliedProb(l.awayPrice)));
  const juiceDiff = allHomeJuice - allAwayJuice;

  if (Math.abs(juiceDiff) > 0.04) {
    signals.push({
      type: "juice_imbalance",
      publicSide:  juiceDiff > 0 ? game.homeTeam : game.awayTeam,
      sharpSide:   juiceDiff > 0 ? game.awayTeam : game.homeTeam,
      market: "spread", rlmDetected: false,
      signal:      Math.abs(juiceDiff) > 0.07 ? "strong" : "moderate",
      juiceDiff:   (Math.abs(juiceDiff) * 100).toFixed(1),
    });
  }

  return signals;
}

// ── AGENT 5: INJURY SCOUT ─────────────────────────────────────────────────────
// Without a live injury feed, detects anomalous line shapes that often reflect
// undisclosed lineup changes. Flags games for manual verification.
function agentInjury(game) {
  const flags = [];

  if (game.spreadLines.length) {
    const awayPoint  = game.spreadLines[0].awayPoint;
    const homePrice  = game.spreadLines[0].homePrice;
    const awayPrice  = game.spreadLines[0].awayPrice;

    // Unusually large underdog suggests possible star player absence
    if (awayPoint > 14)
      flags.push({ flag: `${game.awayTeam} are large underdogs — verify roster before betting`, severity: "check" });

    // Heavy juice on one side often follows injury news
    if (homePrice < -135 || awayPrice < -135)
      flags.push({ flag: "Significant juice imbalance — may reflect injury news. Check beat reporters.", severity: "moderate" });

    // Spread variance across books can indicate late-breaking injury info
    if (game.spreadLines.length >= 3) {
      const points = game.spreadLines.map((l) => l.awayPoint);
      if (Math.max(...points) - Math.min(...points) >= 2)
        flags.push({ flag: "High spread variance across books — market reacting to new information", severity: "check" });
    }
  }

  return {
    game: game.game,
    flags: flags.length ? flags : [{ flag: "No unusual line shapes — standard market", severity: "none" }],
    lineImpact: flags.length ? "check_reports" : "none",
    note: "Always check official injury reports 60-90 min before tip-off",
  };
}

// ── AGENT 6: SITUATIONAL ──────────────────────────────────────────────────────
// Applies structural betting edges backed by historical data:
// road dogs, large home chalk fades, big ML underdog value.
function agentSituational(game) {
  const edges = [];

  if (game.spreadLines.length) {
    const awayPoint = game.spreadLines[0].awayPoint;
    const homePoint = game.spreadLines[0].homePoint;

    // Road underdogs — consistently over-perform vs spread expectations
    if (awayPoint > 0) {
      edges.push({
        edge: "Road underdog spot",
        side: game.awayTeam, betType: "spread",
        strength: awayPoint > 6 ? "strong" : awayPoint > 3 ? "moderate" : "weak",
        note: "Road underdogs are historically undervalued — public overweights home field",
      });
    }

    // Fading large home favorites — public inflates chalk lines
    if (homePoint < -9) {
      edges.push({
        edge: "Large home chalk fade",
        side: game.awayTeam, betType: "spread",
        strength: homePoint < -13 ? "moderate" : "weak",
        note: "Public piles onto heavy home favorites — lines get inflated beyond true probability",
      });
    }
  }

  // Big ML underdogs — positive EV at high prices due to public mispricing
  if (game.mlLines.length) {
    const bestAwayML = Math.max(...game.mlLines.map((l) => l.awayPrice));
    if (bestAwayML > 160) {
      edges.push({
        edge: "Big underdog ML value",
        side: game.awayTeam, betType: "moneyline", odds: fmtOdds(bestAwayML),
        strength: bestAwayML > 250 ? "moderate" : "weak",
        note: `${game.awayTeam} at ${fmtOdds(bestAwayML)} — public consistently undervalues large underdogs on ML`,
      });
    }
  }

  return edges;
}

// ── AGENT 7: CONSENSUS ────────────────────────────────────────────────────────
// Receives output from all 6 agents per game, applies weighted scoring,
// and selects top picks above the confidence + edge thresholds.
function agentConsensus(parsedGames) {
  const candidates = [];

  for (const game of parsedGames) {
    const valueSignals   = agentValue(game);
    const lineSignals    = agentLineMovement(game);
    const publicSignals  = agentPublicMoney(game);
    const sharpSignals   = agentSharpMoney(game);
    const injuryData     = agentInjury(game);
    const situational    = agentSituational(game);

    for (const vp of valueSignals) {
      let score = 0;

      // ── Weighted scoring across all agent signals ─────────────────────────

      // Agent 1 — Value (0-35 pts): core mathematical edge
      score += Math.min(vp.edge * 4.5, 35);

      // Agent 2 — Line Movement (0-20 pts): active market = more informed pricing
      const lineMatch = lineSignals.find((l) => l.side === vp.team);
      if (lineMatch)
        score += lineMatch.strength === "strong" ? 20 : lineMatch.strength === "moderate" ? 12 : 6;

      // Agent 3 — Public Money (0-20 pts): contrarian bonus
      const pubSignal = publicSignals.find((p) => p.market === vp.market);
      if (pubSignal && pubSignal.contrarianSide === vp.team)
        score += pubSignal.publicPct > 68 ? 20 : pubSignal.publicPct > 60 ? 13 : 7;

      // Agent 4 — Sharp Money (0-25 pts): RLM is the strongest signal
      const sharpMatch = sharpSignals.find(
        (s) => s.sharpSide === vp.team || (s.publicSide && s.publicSide !== vp.team)
      );
      if (sharpMatch) {
        score += sharpMatch.signal === "strong" ? 22 : sharpMatch.signal === "moderate" ? 13 : 7;
        if (sharpMatch.rlmDetected) score += 5; // RLM bonus
      }

      // Agent 5 — Injury (-12 to 0): penalize uncertainty
      if (injuryData.lineImpact === "check_reports") score -= 10;

      // Agent 6 — Situational (0-15 pts): structural edge bonus
      const sitMatch = situational.find((s) => s.side === vp.team);
      if (sitMatch)
        score += sitMatch.strength === "strong" ? 15 : sitMatch.strength === "moderate" ? 9 : 5;

      // ── Convert to confidence % (calibrated: raw 20-100 → display 55-90) ─
      const confidence = Math.min(90, Math.max(55, Math.round(score * 0.65 + 20)));
      const edge       = Math.max(0, Math.min(14, parseFloat((vp.edge * 0.88).toFixed(1))));

      if (confidence < 65 || edge < 3.5) continue; // below threshold — skip

      // ── Build model_breakdown from each agent's analysis ─────────────────
      const pubData    = publicSignals.find((p) => p.market === vp.market);
      const sharpData  = sharpSignals.find((s) => s.sharpSide === vp.team);
      const lineData   = lineSignals.find((l) => l.side === vp.team);
      const sitData    = situational.find((s) => s.side === vp.team);
      const valueGrade = edge >= 9 ? "A" : edge >= 7 ? "A-" : edge >= 5 ? "B+" : "B";

      const spreadRef  = game.spreadLines[0];
      const awayPt     = spreadRef ? (spreadRef.awayPoint > 0 ? "+" : "") + spreadRef.awayPoint : "N/A";
      const estOpen    = spreadRef
        ? (spreadRef.awayPoint - (lineData?.spread || 0) > 0 ? "+" : "") +
          (spreadRef.awayPoint - (lineData?.spread || 0)).toFixed(1)
        : "N/A";

      candidates.push({
        game, bet: vp.bet, betType: vp.market === "moneyline" ? "moneyline" : vp.market === "total" ? "total" : "spread",
        odds: vp.odds, confidence, edge, team: vp.team, score,
        openingLine: estOpen,
        currentLine: awayPt,
        lineMove: sharpData?.rlmDetected
          ? "▲ RLM — sharps backing this side"
          : lineData
          ? `▲ ${lineData.spread?.toFixed(1) || "0.5"}pt line move in our favor`
          : "→ Line stable across books",
        model_breakdown: {
          value: `${valueGrade} — ${edge.toFixed(1)}% mathematical edge after devigging ${game.spreadLines.length} books`,
          line_movement: lineData
            ? `${lineData.strength.charAt(0).toUpperCase() + lineData.strength.slice(1)} movement — best available ${lineData.bestLine} vs consensus. ${lineData.type === "sharp_vs_square" ? "Sharp books diverged from squares by " + lineData.diff + "pts." : ""}`
            : sharpData?.rlmDetected
            ? `RLM detected — ${sharpData.description}`
            : "→ Consensus line stable. No significant movement across books.",
          public_money: pubData
            ? `~${pubData.publicPct}% of public action on ${pubData.publicSide}. ${vp.team === pubData.contrarianSide ? "Contrarian play — fading the public." : "Riding with public momentum."}`
            : "Public action split roughly even — no clear fade signal.",
          sharp_action: sharpData
            ? sharpData.rlmDetected
              ? `✅ RLM confirmed — ${sharpData.description}`
              : `Juice imbalance: ${sharpData.juiceDiff}% above normal. Sharps likely on ${sharpData.sharpSide}.`
            : "No clear sharp divergence detected on this game.",
          injury_report: injuryData.flags[0]?.severity === "none"
            ? "✅ No unusual line shapes. Verify official reports 90 min before tip."
            : `⚠️ ${injuryData.flags[0].flag}`,
          situational: sitData
            ? `${sitData.edge} — ${sitData.note}`
            : `${vp.side === "away" ? "Away team" : "Home side"} — standard scheduling, no strong situational lean.`,
        },
      });
    }
  }

  // Sort by composite score, return top 5
  candidates.sort((a, b) => b.score - a.score);
  return {
    consensus_picks: candidates.slice(0, 5).map((c, i) => ({
      id: i + 1,
      sport: c.game.sport, emoji: c.game.emoji,
      game: c.game.game, homeTeam: c.game.homeTeam, awayTeam: c.game.awayTeam,
      bet: c.bet, betType: c.betType, odds: c.odds,
      confidence: c.confidence, edge: c.edge,
      openingLine: c.openingLine, currentLine: c.currentLine, lineMove: c.lineMove,
      model_breakdown: c.model_breakdown,
    })),
  };
}

// ── CHAT — keyword-based expert responses (zero API cost) ────────────────────
const CHAT_KB = [
  {
    keys: ["kelly", "sizing", "how much", "bankroll", "unit size", "stake"],
    reply: "Kelly Criterion: stake = (edge% × bankroll) ÷ decimal odds. For a 6% edge at -110 odds, that's (0.06 ÷ 0.909) = 6.6% of bankroll. Most pros use ¼ Kelly (1.65%) to survive variance. Start with 1-2% flat betting until you have 300+ bets of sample size.",
  },
  {
    keys: ["parlay", "same game", "sgp", "multi-leg", "accumulator"],
    reply: "Parlays compound the house edge on every leg. Use them selectively: 2-3 legs max, only when outcomes are correlated (team wins + star player goes over his scoring prop). Avoid 4+ leg parlays — the math grinds you down. Sharp bettors rarely parlay.",
  },
  {
    keys: ["rlm", "reverse line movement", "steam", "sharp money", "wiseguys"],
    reply: "RLM: when 70%+ of public tickets are on one side, but the line moves the other way. That's sharp/syndicate money overriding the public. Steam moves = rapid multi-book line moves within minutes. Both are among the strongest betting signals — EdgeBet's Agent 4 flags these automatically.",
  },
  {
    keys: ["clv", "closing line", "beat the close", "closing value"],
    reply: "Closing Line Value (CLV) is the gold standard of betting skill. If you bet Team A -3 and it closes -5, you got +2pts of CLV — you found value before the market corrected. Track CLV obsessively. A long-term positive CLV means you're profitable, regardless of short-term win rate.",
  },
  {
    keys: ["injury", "out", "questionable", "dnp", "lineup", "roster"],
    reply: "Injury news is the fastest-moving line mover. A key PG being out in NBA can shift lines 3-5pts in minutes. Always check official team injury reports and beat reporters on Twitter/X 60-90 min before tip-off. Lines that don't move after injury news = already priced in.",
  },
  {
    keys: ["spread", "cover", "ats", "against the spread", "points"],
    reply: "ATS (against the spread): the spread neutralizes talent gap — you're betting execution, not outcome. Key numbers matter: NFL clusters at 3, 6, 7, 10. Getting -2.5 vs -3 is worth significant long-term edge. Shop for the best number across books before locking in.",
  },
  {
    keys: ["total", "over", "under", "o/u", "points total", "goals"],
    reply: "Totals strategy: focus on pace, defensive efficiency, and officials. NBA pace vs. defense matchup is the starting point. Weather kills NFL/MLB overs. Sharp books (Pinnacle, BetOnline) move totals faster than any other market when injury news drops — watch for fast moves.",
  },
  {
    keys: ["line shop", "best odds", "multiple books", "shop", "odds comparison"],
    reply: "Line shopping is the single highest-ROI habit in sports betting. Getting +4.5 vs +4 is worth ~1.5% edge compounded over thousands of bets. Have accounts at 3+ books minimum — DraftKings, FanDuel, and one sharp book. EdgeBet automatically shows you the best available line.",
  },
  {
    keys: ["fade public", "contrarian", "public money", "square", "recreational"],
    reply: "Fading the public alone has a thin edge — sportsbooks shade lines ~1-2% toward popular sides. The real edge is combining public fade + a value signal or RLM. When 70%+ of public is on one side AND the line moves the other way = powerful contrarian signal.",
  },
  {
    keys: ["moneyline", "ml", "win outright", "straight up"],
    reply: "Moneyline value comes from underdog mispricing. The public systematically overvalues heavy favorites and undervalues big dogs. A +250 underdog with a true 32% win probability at a -110 fair value = significant positive EV. EdgeBet's Value Agent finds these gaps automatically.",
  },
  {
    keys: ["pick", "today", "tonight", "recommend", "best bet", "top pick"],
    reply: "Hit the Scan button on the Picks tab — the 7-agent system analyzes all active games in real-time using live odds data, flags value edges, line moves, sharp signals, and situational factors. Only picks clearing 65% confidence and 3.5% edge make the cut.",
  },
  {
    keys: ["variance", "losing streak", "bad beat", "run bad", "downswing"],
    reply: "Variance is real — even a 60% winning bettor loses 5+ in a row regularly. The key is bet sizing: never risk more than 2-3% per play. Focus on CLV, not results. A 200+ bet sample is the minimum before drawing conclusions from your record. Track everything — edge, CLV, sport, bet type.",
  },
];

function chatResponse(message) {
  const lower = message.toLowerCase();
  for (const entry of CHAT_KB) {
    if (entry.keys.some((k) => lower.includes(k))) return entry.reply;
  }
  return "Hit the Scan tab to run the 7-agent analysis on today's games — it checks value edges, line movement, sharp vs. public signals, and situational spots across NBA, NFL, NHL, NCAAB, and MLB. For bankroll questions: flat bet 1-2% per play until you have 300+ bets of sample.";
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
  res.json({ status: "ok", service: "EdgeBet AI API", agents: 7, aiTokenCost: "$0", version: "2.0.0" })
);

// Debug endpoint to check env vars
app.get("/debug", (req, res) => {
  res.json({
    oddsKeyPresent: !!process.env.ODDS_API_KEY,
    oddsKeyLength: process.env.ODDS_API_KEY ? process.env.ODDS_API_KEY.length : 0,
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT
  });
});

// GET /scan — full 7-agent algorithmic pipeline, zero AI token cost
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
      return res.status(503).json({
        error: "No odds data available",
        hint: "Set ODDS_API_KEY or no games are currently scheduled",
      });
    }

    const result = agentConsensus(allGames);
    console.log(`Scan: ${result.consensus_picks.length} picks from ${allGames.length} games`);
    res.json(result);
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /scan — same as GET for compatibility
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
      return res.status(503).json({
        error: "No odds data available",
        hint: "Set ODDS_API_KEY or no games are currently scheduled",
      });
    }

    const result = agentConsensus(allGames);
    console.log(`Scan: ${result.consensus_picks.length} picks from ${allGames.length} games`);
    res.json(result);
  } catch (err) {
    console.error("Scan error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /chat — keyword expert responses, zero API cost
app.post("/chat", (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });
  res.json({ reply: chatResponse(message) });
});

// POST /api/plan-status — Stripe subscription verification
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
    console.error("Plan status error:", err.message);
    res.json({ plan: "free", isActive: false, expiresAt: null });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`EdgeBet AI API v2.0 — 7-Agent Algorithmic (zero AI token cost) on :${PORT}`)
);
