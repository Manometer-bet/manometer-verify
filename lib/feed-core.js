// feed-core.js — external originator feed: proposal contract, market taxonomy, state machine,
// per-source policy engine, CLV scoring + qualification ladder.
// PURE + node-testable: no chrome.*, no DOM, no fetch. Browser: loaded via <script>, exposes
// window.FEED. Node: require("./feed-core.js").
//
// Design (agreed 2026-07): every external signal is a PROPOSAL — no source ever places directly.
// Lifecycle: submitted → valid → enriched → proposed → accepted|rejected|expired → placed →
// settled → graded. The per-source policy on OUR side decides stake + confirmation; originator
// numbers (ev, stakeHint) are input, never truth — EV is always recomputed against the real
// executable book odds, and a per-source edge HAIRCUT is applied before sizing (lesson: logged
// edge was ~16x overstated vs realized; trust must be earned via CLV, see feedQualify).
//
// First external source: CS2 via SportMarket (read engine per SMK handoff doc). CS2 markets
// cover the full map board: match ML (2-way), map handicap (maps), maps total, per-map winner
// and per-map rounds AH / rounds total (scope map1|map2|map3).

(function () {
  "use strict";

  function _num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }

  // ---------- market taxonomy -------------------------------------------------------------
  // scope = which part of the event the bet refers to; unit = what the line counts.
  var FEED_SPORTS = ["fb", "basket", "tennis", "cs2"];
  var FEED_MARKETS = {
    fb: {
      "1x2":   { scopes: ["match"], unit: null,     needsLine: false, sels: ["1", "X", "2"] },
      "ah":    { scopes: ["match"], unit: "goals",  needsLine: true,  sels: ["home", "away"] },
      "total": { scopes: ["match"], unit: "goals",  needsLine: true,  sels: ["over", "under"] }
    },
    basket: {
      // otIncluded flag lives on the proposal (basket books differ: incl. OT vs regulation)
      "ml":     { scopes: ["match"], unit: null,     needsLine: false, sels: ["home", "away"] },
      "spread": { scopes: ["match"], unit: "points", needsLine: true,  sels: ["home", "away"] },
      "total":  { scopes: ["match"], unit: "points", needsLine: true,  sels: ["over", "under"] }
    },
    tennis: {
      // settleRule ("retirement handling") lives on the proposal — book-dependent
      "ml":         { scopes: ["match"], unit: null,    needsLine: false, sels: ["home", "away"] },
      "setHc":      { scopes: ["match"], unit: "sets",  needsLine: true,  sels: ["home", "away"] },
      "gamesHc":    { scopes: ["match"], unit: "games", needsLine: true,  sels: ["home", "away"] },
      "gamesTotal": { scopes: ["match"], unit: "games", needsLine: true,  sels: ["over", "under"] }
    },
    cs2: {
      "ml":          { scopes: ["match"], unit: null,    needsLine: false, sels: ["home", "away"] },
      "mapHc":       { scopes: ["match"], unit: "maps",  needsLine: true,  sels: ["home", "away"] },
      "mapsTotal":   { scopes: ["match"], unit: "maps",  needsLine: true,  sels: ["over", "under"] },
      "mapWinner":   { scopes: ["map1", "map2", "map3"], unit: null,     needsLine: false, sels: ["home", "away"] },
      "roundsAh":    { scopes: ["map1", "map2", "map3"], unit: "rounds", needsLine: true,  sels: ["home", "away"] },
      "roundsTotal": { scopes: ["map1", "map2", "map3"], unit: "rounds", needsLine: true,  sels: ["over", "under"] }
    }
  };

  // ---------- proposal lifecycle ----------------------------------------------------------
  var FEED_STATES = ["submitted", "valid", "enriched", "proposed", "accepted", "rejected", "expired", "placed", "settled", "graded"];
  var FEED_NEXT = {
    submitted: ["valid", "rejected"],
    valid:     ["enriched", "rejected", "expired"],
    enriched:  ["proposed", "rejected", "expired"],
    proposed:  ["accepted", "rejected", "expired"],
    accepted:  ["placed", "rejected"],        // placement itself can still fail -> rejected(placement_failed)
    placed:    ["settled"],
    settled:   ["graded"],
    rejected:  [], expired: [], graded: []    // terminal (graded carries CLV/PnL feedback)
  };
  function feedCanTransition(from, to) { return !!(FEED_NEXT[from] && FEED_NEXT[from].indexOf(to) >= 0); }

  // ---------- proposal validation ---------------------------------------------------------
  // Returns { ok, errors[] }. Hard rules baked in: unknown kickoff blocks (kickoff-gate lesson),
  // expired-by-TTL blocks (value decays), fairOdds must come with its devig method (EVs are not
  // comparable otherwise).
  function feedValidateProposal(p, nowTs) {
    var errs = [];
    var now = _num(nowTs) != null ? nowTs : Date.now();
    if (!p || typeof p !== "object") return { ok: false, errors: ["no payload"] };
    if (!p.proposalId || typeof p.proposalId !== "string") errs.push("proposalId missing (idempotency key)");
    if (!p.sourceId) errs.push("sourceId missing");
    if (FEED_SPORTS.indexOf(p.sport) < 0) errs.push("sport must be one of " + FEED_SPORTS.join("|"));
    var ev = p.eventIdentity || {};
    if (!ev.home || !ev.away) errs.push("eventIdentity.home/away missing");
    var starts = _num(ev.startsTs);
    if (starts == null) errs.push("eventIdentity.startsTs missing (unknown kickoff = blocked)");
    var mdef = (FEED_MARKETS[p.sport] || {})[p.mkt];
    if (!mdef) errs.push("mkt '" + String(p.mkt) + "' not allowed for sport '" + String(p.sport) + "'");
    else {
      var scope = p.scope || "match";
      if (mdef.scopes.indexOf(scope) < 0) errs.push("scope '" + scope + "' invalid for " + p.sport + "/" + p.mkt + " (allowed: " + mdef.scopes.join("|") + ")");
      if (mdef.needsLine && _num(p.line) == null) errs.push("line required for " + p.mkt + " (unit: " + mdef.unit + ")");
      if (!mdef.needsLine && p.line != null) errs.push("line not allowed for " + p.mkt);
      if (mdef.sels.indexOf(p.sel) < 0) errs.push("sel must be one of " + mdef.sels.join("|"));
    }
    var fair = _num(p.fairOdds);
    if (fair == null || fair <= 1) errs.push("fairOdds must be a number > 1");
    if (!p.devigMethod) errs.push("devigMethod missing (how fairOdds was derived, e.g. shin)");
    var mo = _num(p.minOdds);
    if (mo == null || mo <= 1) errs.push("minOdds must be a number > 1");
    var ts = _num(p.tsCreated);
    if (ts == null) errs.push("tsCreated missing");
    var ttl = _num(p.ttlMs);
    if (ttl == null || ttl <= 0) errs.push("ttlMs missing or invalid");
    if (p.live != null && typeof p.live !== "boolean") errs.push("live must be a boolean if present");
    if (!errs.length && now > ts + ttl) errs.push("expired (age " + Math.round((now - ts) / 1000) + "s > ttl " + Math.round(ttl / 1000) + "s)");
    // Kickoff gate. PREMATCH (default): reject at/after match start — the v1.20.83 phantom-EV rule
    // (stale prematch fair vs live price). LIVE (p.live === true): the originator supplies its OWN
    // live fair, so in-play is allowed — but a live signal must be AFTER kickoff (else it isn't live)
    // and BEFORE an optional endsTs (segment/match over). Freshness is governed by ttlMs (+ policy
    // maxAgeMs) — a live fair decays in seconds. Default path stays byte-identical.
    if (!errs.length && starts != null) {
      if (p.live === true) {
        if (now < starts) errs.push("live:true but event has not started yet (now < startsTs) — not an in-play signal");
        var ends = _num(p.endsTs);
        if (ends != null && now >= ends) errs.push("live signal but event already finished (now >= endsTs)");
      } else {
        if (now >= starts) errs.push("event already started (kickoff gate) — set live:true for in-play signals");
      }
    }
    return errs.length ? { ok: false, errors: errs } : { ok: true, errors: [] };
  }

  // ---------- EV ---------------------------------------------------------------------------
  // Real EV against the EXECUTABLE book price — never trust the originator's claimed ev.
  function feedRealEv(fairOdds, bookOdds) {
    var f = _num(fairOdds), b = _num(bookOdds);
    if (f == null || b == null || f <= 1 || b <= 1) return null;
    return b / f - 1;
  }

  // ---------- source registry --------------------------------------------------------------
  var FEED_TIERS = ["shadow", "qualifying", "live_small", "live"];
  function feedSourceDefaults(id, name) {
    return {
      id: String(id || ""), name: String(name || id || ""),
      transport: "http",             // http | ws | extension | internal
      enabled: true, killed: false,  // killed = hard kill switch, wins over enabled
      tier: "shadow",                // every new source starts paper-only
      allowLive: false,              // in-play (p.live) opt-in — top-level so the dashboard toggle owns it
      policy: {
        stakeMode: "ignore",         // ignore (own Kelly on haircut edge) | scale (of stakeHint) | fixed
        scalePct: 50, fixedEur: 2,
        kellyFrac: 0.25,             // own-Kelly fraction applied to the HAIRCUT edge
        edgeHaircut: 0.7,            // trust only (1-haircut) of the recomputed EV until CLV proves more
        confirmMode: "telegram",     // telegram | dashboard | auto (auto sensible only for tier live)
        minEvPct: 3,                 // gate on the REAL recomputed EV, before haircut
        oddsMin: 1.3, oddsMax: 6,
        maxAgeMs: 120000,
        allowLive: false,            // in-play proposals (p.live) rejected unless the operator enables it
        liveMaxAgeMs: 15000,         // live fair decays fast -> much tighter freshness than prematch
        sports: ["fb", "basket", "tennis", "cs2"]
      },
      caps: { maxStakeEur: 10, dayExposureEur: 50, maxOpen: 5 },
      stats: { lastSeen: 0, submitted: 0, proposed: 0, accepted: 0, rejected: 0 }
    };
  }

  // ---------- policy decision --------------------------------------------------------------
  // src = registry record, p = validated proposal,
  // ctx = { nowTs, bankrollEur, bookOdds (executable, fresh), openCount, dayStakedEur }.
  // Returns { action:"reject", reason } or
  // { action:"propose", paper, confirmMode, stakeEur, evRealPct, evUsedPct, minOdds }.
  // minOdds handed to placement = max(originator floor, book*0.98 slippage floor).
  function feedPolicyDecide(src, p, ctx) {
    function rej(r) { return { action: "reject", reason: r }; }
    if (!src || src.killed) return rej("source killed");
    if (!src.enabled) return rej("source disabled");
    var pol = src.policy || {}, caps = src.caps || {};
    if ((pol.sports || []).indexOf(p.sport) < 0) return rej("sport not whitelisted for this source");
    // allowLive may sit at the source top-level (dashboard toggle) OR in policy (defaults) — either enables.
    if (p.live === true && !(src.allowLive === true || pol.allowLive === true)) return rej("live signals not enabled for this source");
    var now = _num(ctx && ctx.nowTs) != null ? ctx.nowTs : Date.now();
    var ts = _num(p.tsCreated);
    // live fair decays in seconds -> apply the (much tighter) liveMaxAgeMs; prematch uses maxAgeMs.
    var maxAge = (p.live === true) ? (_num(pol.liveMaxAgeMs) != null ? pol.liveMaxAgeMs : 15000) : (pol.maxAgeMs || 120000);
    if (ts != null && now - ts > maxAge) return rej("stale signal (age > " + (p.live === true ? "liveMaxAgeMs" : "maxAgeMs") + ")");
    var book = _num(ctx && ctx.bookOdds);
    if (book == null || book <= 1) return rej("no executable book odds");
    if (book < (_num(p.minOdds) || 0)) return rej("line moved below originator minOdds");
    if (book < (pol.oddsMin || 0) || book > (pol.oddsMax || 1e9)) return rej("odds outside policy band");
    var evReal = feedRealEv(p.fairOdds, book);
    if (evReal == null) return rej("cannot recompute EV");
    if (evReal * 100 < (pol.minEvPct != null ? pol.minEvPct : 3)) return rej("real EV below policy minimum");
    var hc = (pol.edgeHaircut != null ? pol.edgeHaircut : 0.7);
    var evCut = evReal * (1 - hc);
    if ((ctx.openCount || 0) >= (caps.maxOpen || 5)) return rej("max open bets reached");
    // stake per policy — originator stakeHint never binds
    var stake = 0;
    if (pol.stakeMode === "fixed") stake = _num(pol.fixedEur) || 0;
    else if (pol.stakeMode === "scale") stake = (Number(p.stakeHint) > 0 ? Number(p.stakeHint) : 0) * ((pol.scalePct || 0) / 100);
    else { // own Kelly on the haircut edge: f = evCut/(book-1), scaled by kellyFrac
      var f = evCut / (book - 1);
      stake = Math.max(0, (Number(ctx.bankrollEur) || 0) * f * (pol.kellyFrac || 0.25));
    }
    stake = Math.min(stake, _num(caps.maxStakeEur) != null ? caps.maxStakeEur : stake);
    if ((Number(ctx.dayStakedEur) || 0) + stake > (_num(caps.dayExposureEur) != null ? caps.dayExposureEur : Infinity)) return rej("daily exposure cap reached");
    stake = Math.round(stake * 100) / 100;
    if (!(stake > 0)) return rej("stake computes to 0");
    var paper = (src.tier === "shadow" || src.tier === "qualifying");
    return {
      action: "propose", paper: paper, live: (p.live === true),
      confirmMode: paper ? "none" : (pol.confirmMode || "telegram"),
      stakeEur: stake,
      evRealPct: Math.round(evReal * 10000) / 100,
      evUsedPct: Math.round(evCut * 10000) / 100,
      minOdds: Math.max(_num(p.minOdds) || 0, Math.round(book * 0.98 * 1000) / 1000)
    };
  }

  // ---------- scoring + qualification ------------------------------------------------------
  // CLV in % of the TAKEN odds vs the no-vig closing price of the agreed reference book.
  function feedClvPct(takenOdds, closingNvp) {
    var t = _num(takenOdds), c = _num(closingNvp);
    if (t == null || c == null || t <= 1 || c <= 1) return null;
    return (t / c - 1) * 100;
  }

  // recs: graded proposal records
  // { takenOdds, closingNvp, evClaimedPct, evRealPct, result, stake, profit, executable }
  function feedScorecard(recs) {
    var out = { n: 0, graded: 0, execRate: null, avgClvPct: null, beatRate: null, roiPct: null, evHonestyPct: null };
    if (!Array.isArray(recs) || !recs.length) return out;
    out.n = recs.length;
    var execN = 0, clvSum = 0, clvN = 0, beats = 0, stake = 0, profit = 0, honSum = 0, honN = 0, graded = 0;
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i]; if (!r) continue;
      if (r.executable !== false) execN++;
      var clv = feedClvPct(r.takenOdds, r.closingNvp);
      if (clv != null) { clvSum += clv; clvN++; if (clv > 0) beats++; }
      if (r.result === "WIN" || r.result === "LOSS" || r.result === "HALF_WIN" || r.result === "HALF_LOSS") {
        graded++; stake += Number(r.stake) || 0; profit += Number(r.profit) || 0;
      }
      if (_num(r.evClaimedPct) != null && _num(r.evRealPct) != null) { honSum += (r.evClaimedPct - r.evRealPct); honN++; }
    }
    out.graded = graded;
    out.execRate = Math.round(execN / recs.length * 1000) / 10;
    if (clvN) { out.avgClvPct = Math.round(clvSum / clvN * 100) / 100; out.beatRate = Math.round(beats / clvN * 1000) / 10; }
    if (stake > 0) out.roiPct = Math.round(profit / stake * 1000) / 10;
    if (honN) out.evHonestyPct = Math.round(honSum / honN * 100) / 100;   // >0 = source oversells its edges
    return out;
  }

  // Promotion: CLV is the PRIMARY criterion (profit on small samples is variance — proven by the
  // own backtest: +profit at CLV≈0). Profit is displayed, never qualifies. days = observed period.
  function feedQualify(sc, days, cfg) {
    var c = cfg || {};
    var nMin = c.nMin != null ? c.nMin : 100;
    var daysMin = c.daysMin != null ? c.daysMin : 30;
    var execMin = c.execMin != null ? c.execMin : 60;    // % of proposals that were executable
    var beatMin = c.beatMin != null ? c.beatMin : 55;    // % closing-beat rate
    var clvMin = c.clvMin != null ? c.clvMin : 1.5;      // avg CLV %
    if (!sc || sc.n < nMin) return { tier: "shadow", reason: "sample " + (sc ? sc.n : 0) + "/" + nMin };
    if ((days || 0) < daysMin) return { tier: "shadow", reason: "period " + (days || 0) + "/" + daysMin + "d" };
    if (sc.execRate != null && sc.execRate < execMin) return { tier: "shadow", reason: "execRate " + sc.execRate + "% < " + execMin + "%" };
    var clvOk = (sc.beatRate != null && sc.beatRate >= beatMin) || (sc.avgClvPct != null && sc.avgClvPct >= clvMin);
    if (!clvOk) return { tier: "qualifying", reason: "CLV not proven (beat " + sc.beatRate + "%, avg " + sc.avgClvPct + "%)" };
    return { tier: "live_small", reason: "qualified: beat " + sc.beatRate + "%, avgCLV " + sc.avgClvPct + "%" };
  }

  // Rolling demotion: edges die — a live source whose rolling-window CLV collapses gets pulled.
  function feedDemote(windowSc, cfg) {
    var floor = (cfg && cfg.demoteClvPct != null) ? cfg.demoteClvPct : 0;
    if (windowSc && windowSc.avgClvPct != null && windowSc.avgClvPct < floor)
      return { demote: true, reason: "rolling CLV " + windowSc.avgClvPct + "% < " + floor + "%" };
    return { demote: false };
  }

  // ---------- shared-folder ingest (transport A) --------------------------------------------
  // Originator extensions on the SAME machine append envelopes to feed-inbox.ndjson in the shared
  // folder; we validate and write receipts to feed-receipts.ndjson. This is the PURE part: no IO.
  // envelopes: [{ sourceId, apiKey, proposal }], seen: Set of already-receipted proposalIds
  // (mutated), sources: { id: { key, enabled, tier } } from fund-config.json feedSources.
  // Returns { receipts, accepted }. SHADOW-ONLY by design: accepted records are paper, never bets.
  // apiKey is checked but NEVER echoed into receipts/records.
  function feedProcessEnvelopes(envelopes, seen, sources, nowTs) {
    var receipts = [], accepted = [];
    var src = sources || {};
    var now = _num(nowTs) != null ? nowTs : Date.now();
    for (var i = 0; i < (envelopes || []).length; i++) {
      var e = envelopes[i];
      if (!e || typeof e !== "object") continue;
      var p = (e.proposal && typeof e.proposal === "object") ? e.proposal : null;
      var pid = (p && typeof p.proposalId === "string" && p.proposalId) ? p.proposalId : null;
      if (!pid) { receipts.push({ ts: now, proposalId: null, sourceId: (e.sourceId != null ? String(e.sourceId) : null), ok: false, state: "rejected", errors: ["no proposal.proposalId"] }); continue; }
      if (seen && seen.has(pid)) continue;   // duplicate submission — deduped, no second receipt
      if (seen) seen.add(pid);
      var base = { ts: now, proposalId: pid, sourceId: (e.sourceId != null ? String(e.sourceId) : null) };
      var s = (e.sourceId != null) ? src[String(e.sourceId)] : null;
      if (!s) { receipts.push(Object.assign(base, { ok: false, state: "rejected", errors: ["unknown source (not registered in feedSources)"] })); continue; }
      if (s.enabled === false) { receipts.push(Object.assign(base, { ok: false, state: "rejected", errors: ["source disabled"] })); continue; }
      if (s.key && String(e.apiKey || "") !== String(s.key)) { receipts.push(Object.assign(base, { ok: false, state: "rejected", errors: ["bad api key"] })); continue; }
      var v = feedValidateProposal(p, now);
      if (!v.ok) { receipts.push(Object.assign(base, { ok: false, state: "rejected", errors: v.errors })); continue; }
      var tier = s.tier || "shadow";
      receipts.push(Object.assign(base, { ok: true, state: "valid", tier: tier, paper: true }));
      accepted.push({ ts: now, state: "valid", tier: tier, paper: true, sourceId: base.sourceId, proposal: p });
    }
    return { receipts: receipts, accepted: accepted };
  }

  // ---------- decision stage (paper) --------------------------------------------------------
  // A stored source from the dashboard is minimal ({key,enabled,tier,allowLive}); the policy engine
  // needs full policy+caps (else pol.sports is undefined -> everything "sport not whitelisted").
  // feedSourceNormalize overlays the stored fields onto the defaults so any source is decision-ready.
  function feedSourceNormalize(stored, id) {
    var d = feedSourceDefaults(id || (stored && stored.id) || "");
    stored = stored || {};
    ["name", "transport", "enabled", "killed", "tier", "allowLive", "createdTs", "key"].forEach(function (k) {
      if (stored[k] !== undefined) d[k] = stored[k];
    });
    if (stored.policy) for (var pk in stored.policy) if (stored.policy[pk] !== undefined) d.policy[pk] = stored.policy[pk];
    if (stored.caps) for (var ck in stored.caps) if (stored.caps[ck] !== undefined) d.caps[ck] = stored.caps[ck];
    return d;
  }

  // Turn a validated proposal into a PAPER decision using the per-source policy. Executable odds come
  // from the proposal's originOdds (the SMK price the originator observed on the same sharp feed) —
  // flagged oddsSource:"originator". At REAL placement (later) we re-resolve fresh on our side.
  // EV is always recomputed here (never the originator's claimed ev). Returns the feedPolicyDecide
  // object (+oddsSource/bookOdds) or a defer if no executable odds are available yet.
  function feedDecide(src, p, ctx) {
    var book = _num(p && p.originOdds);
    if (book == null || book <= 1)
      return { action: "defer", reason: "no executable odds yet — proposal carries no originOdds (needs a fresh SMK CS2 resolve)" };
    var d = feedPolicyDecide(feedSourceNormalize(src, src && src.id), p, Object.assign({}, ctx || {}, { bookOdds: book }));
    if (d && d.action === "propose") { d.oddsSource = "originator"; d.bookOdds = book; }
    return d;
  }

  // Aggregate a source's live exposure from prior decision records, for the caps in feedPolicyDecide.
  // openCount ~ propose-decisions in the last 6h (proxy for still-live in paper, no settlement yet);
  // dayStakedEur = sum of propose stakes since dayStartTs. Approximate but sufficient for paper caps.
  function feedDecisionCtx(decisions, sourceId, nowTs, dayStartTs) {
    var now = _num(nowTs) != null ? nowTs : Date.now();
    var open = 0, dayStaked = 0;
    for (var i = 0; i < (decisions || []).length; i++) {
      var r = decisions[i];
      if (!r || String(r.sourceId) !== String(sourceId)) continue;
      var d = r.decision;
      if (!d || d.action !== "propose") continue;
      var st = _num(d.stakeEur) || 0;
      var rts = _num(r.ts);
      if (dayStartTs == null || (rts != null && rts >= dayStartTs)) dayStaked += st;
      if (rts != null && now - rts <= 6 * 3600 * 1000) open += 1;
    }
    return { openCount: open, dayStakedEur: Math.round(dayStaked * 100) / 100 };
  }

  // ---------- placement encoding (SMK esports) ----------------------------------------------
  // Maps a CS2 proposal to the SMK esports bet_type string. VERIFIED 2026-07-24 from live requests:
  //   match ML      -> for,tp,all,ml,{h|a}
  //   map N winner  -> for,tmap,N,ml,{h|a}
  //   match maps AH -> for,tp,all,ah,{h|a},{code}   (code = line*4; 6 = 1.5 maps)
  // Grammar-inferred (confirm via a zero-money betslip-open before enabling on a money path):
  //   rounds AH map N -> for,tmap,N,ah,{h|a},{code}
  //   totals          -> for,<scope>,ou,{over|under},{code}
  // Returns { betType, verified } or null (unsupported for placement). Only CS2 is wired.
  function feedBetType(p) {
    if (!p || p.sport !== "cs2") return null;
    var scope = p.scope || "match";
    var scopeSeg = (scope === "match") ? "tp,all" : (/^map[123]$/.test(scope) ? ("tmap," + scope.slice(3)) : null);
    if (scopeSeg == null) return null;
    var sideHA = (p.sel === "home") ? "h" : (p.sel === "away") ? "a" : null;
    var mkt = p.mkt;
    if (mkt === "ml" || mkt === "mapWinner") {
      if (!sideHA) return null;
      return { betType: "for," + scopeSeg + ",ml," + sideHA, verified: true };
    }
    if (mkt === "mapHc" || mkt === "roundsAh") {
      if (!sideHA || p.line == null) return null;
      var code = Math.round(Number(p.line) * 4);
      if (!isFinite(code)) return null;
      return { betType: "for," + scopeSeg + ",ah," + sideHA + "," + code, verified: (mkt === "mapHc" && scope === "match") };
    }
    if (mkt === "mapsTotal" || mkt === "roundsTotal") {
      var ou = (p.sel === "over") ? "over" : (p.sel === "under") ? "under" : null;
      if (!ou || p.line == null) return null;
      var codeT = Math.round(Number(p.line) * 4);
      if (!isFinite(codeT)) return null;
      return { betType: "for," + scopeSeg + ",ou," + ou + "," + codeT, verified: false };
    }
    return null;
  }

  // ---------- export ------------------------------------------------------------------------
  var API = {
    FEED_SPORTS: FEED_SPORTS,
    FEED_MARKETS: FEED_MARKETS,
    FEED_STATES: FEED_STATES,
    FEED_TIERS: FEED_TIERS,
    feedCanTransition: feedCanTransition,
    feedValidateProposal: feedValidateProposal,
    feedRealEv: feedRealEv,
    feedSourceDefaults: feedSourceDefaults,
    feedPolicyDecide: feedPolicyDecide,
    feedClvPct: feedClvPct,
    feedScorecard: feedScorecard,
    feedQualify: feedQualify,
    feedDemote: feedDemote,
    feedProcessEnvelopes: feedProcessEnvelopes,
    feedSourceNormalize: feedSourceNormalize,
    feedDecide: feedDecide,
    feedDecisionCtx: feedDecisionCtx,
    feedBetType: feedBetType
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.FEED = API;
})();
