"use strict";
// lib/netz/bewertung.js — einen Vorschlag gegen den Markt beim Empfang bewerten, Schlusskurs (CLV) und Ergebnis (29.10.2026).
// Regeln (stehen so auch in der Methode der Scorecard):
//  • Gilt der Empfangszeitpunkt. Fair = Pinnacle ohne Marge aus dem Schnappschuss, bester ausführbarer Preis = höchste
//    Quote eines NETZ-Buchs (dort kann das Netzwerk setzen) für genau diesen Ausgang.
//  • Ausführbar = gültig (Vertrag v1, nicht abgelaufen, vor Anstoß), nicht zu alt (maxAgeMs der Quelle), Spiel gefunden,
//    Markt bewertbar, Netz-Buch-Preis vorhanden und ≥ minOdds der Quelle. Gründe in der Sprache der feed-docs.
//  • Nachgerechnetes EV (wie feed-docs): bester ausführbarer Preis ÷ fairOdds der Quelle − 1. Behauptet: p.ev.
//  • Board-Kante: bester Preis ÷ Pinnacle-Fair − 1. Ab 2 % stand die Kante schon auf dem Board (= nicht einzigartig).
//  • CLV = bester ausführbarer Preis beim Empfang ÷ Schlusskurs ohne Marge − 1.
//  • Ergebnis aus dem Endstand (Periode 0) des Pinnacle-Ereignisses; Papier-Einsatz 1 Einheit.
// REIN; byte-gleich in netz-verify/lib/ (das Prüfprogramm rechnet CLV und Ergebnis damit nach).

// Bücher, auf denen das Netzwerk setzen kann (Bet-Engine-Adapter + eigenes Orbit-Konto). Referenzen (Sportmarket/Molly,
// Betfair-Ableitung, Pinnacle) und reine Lese-Bücher zählen nicht als ausführbar.
const NETZ_BUECHER = ["efbet", "elabet", "fonbet", "fonbetgr", "interwetten", "mystake", "jackbit", "pamestoixima", "stoiximan", "superbet", "trustdice", "orbitxch"];
const KANTE_SCHON_DA = 0.02;

function flipSeite(s) { return s === "home" ? "away" : s === "away" ? "home" : s; }
function n(x) { const v = Number(x); return isFinite(v) ? v : null; }

// Welcher Markt / welche Seite / welche Linie aus Sicht der BOARD-Zeile. null = (noch) nicht bewertbar.
function auswahl(p, swapped) {
  const mkt = p && p.mkt, sel = p && p.sel;
  if (mkt === "1x2") { let s = sel; if (swapped && (s === "1" || s === "2")) s = s === "1" ? "2" : "1"; return ["1", "X", "2"].indexOf(s) >= 0 ? { markt: "1x2", seite: s } : null; }
  if (mkt === "ml" && p.sport !== "cs2" || (mkt === "ml" && p.sport === "cs2" && (p.scope || "match") === "match")) {
    let s = sel === "home" ? "1" : sel === "away" ? "2" : null; if (!s) return null;
    if (swapped) s = s === "1" ? "2" : "1"; return { markt: "1x2", seite: s };
  }
  if ((mkt === "ah" && p.sport === "fb") || (mkt === "spread" && p.sport === "basket")) {
    const L = n(p.line); if (L == null || (sel !== "home" && sel !== "away")) return null;
    return { markt: "ah", seite: swapped ? flipSeite(sel) : sel, linie: swapped ? -L : L };
  }
  if (mkt === "total" && (p.sport === "fb" || p.sport === "basket")) {
    const L = n(p.line); if (L == null || (sel !== "over" && sel !== "under")) return null;
    return { markt: "tot", seite: sel, linie: L };
  }
  return null;
}
// Schnappschuss-Zeile (Gestalt s. schnappschuss.js): b = [[buch, q1, qX, q2, ts]], f = [f1, fX, f2],
// ah/tot = [[Linie, fairA, fairB, [[buch, a, b]]]].
const IX = { "1": 0, X: 1, "2": 2 };
function linie(lad, L) { if (!Array.isArray(lad)) return null; for (const e of lad) if (Math.abs(Number(e[0]) - L) < 1e-9) return e; return null; }

// Fair + Quoten je Buch für die Auswahl aus einer Schnappschuss-Zeile.
function preise(zeile, a) {
  if (!zeile || !a) return { fair: null, buecher: {} };
  const buecher = {};
  if (a.markt === "1x2") {
    const i = IX[a.seite];
    for (const e of zeile.b || []) { const v = n(e[1 + i]); if (v > 1) buecher[e[0]] = v; }
    return { fair: n(zeile.f && zeile.f[i]), buecher };
  }
  const e = linie(a.markt === "ah" ? zeile.ah : zeile.tot, a.linie);
  if (!e) return { fair: null, buecher };
  const i = (a.seite === "home" || a.seite === "over") ? 0 : 1;
  for (const x of e[3] || []) { const v = n(x[1 + i]); if (v > 1) buecher[x[0]] = v; }
  return { fair: n(e[1 + i]), buecher };
}
function bestesNetzBuch(buecher) {
  let best = null;
  for (const bk of NETZ_BUECHER) { const v = buecher[bk]; if (v > 1 && (!best || v > best.odds)) best = { book: bk, odds: v }; }
  return best;
}

// Bewertung beim Empfang. ctx = { receivedTs, valid:{ok,errors}, maxAgeMs, treffer:{index,swapped,grund}, zeile }
function beiEmpfang(p, ctx) {
  const out = { executable: false, reason: null, fairAtReceipt: null, best: null, evRealPct: null, evClaimedPct: n(p && p.ev),
    boardEdgePct: null, unique: null, leadMs: null, kickoff: null, auswahl: null, bestAll: null };
  const ei = (p && p.eventIdentity) || {};
  out.kickoff = (ctx.zeile && ctx.zeile.ko) || n(ei.startsTs);
  if (out.kickoff) out.leadMs = out.kickoff - ctx.receivedTs;
  if (!ctx.valid || !ctx.valid.ok) {
    const e = (ctx.valid && ctx.valid.errors) || ["invalid"];
    const t = e.join("; ");
    out.reason = /^expired/.test(t) ? "expired" : /kickoff gate|already started/.test(t) ? "event already started" : "invalid proposal: " + t.slice(0, 200);
    return out;
  }
  // Markt beim Empfang IMMER festhalten, wenn das Spiel gefunden ist (auch bei „stale"/„line moved") — das sind Fakten.
  const a = ctx.zeile ? auswahl(p, !!(ctx.treffer && ctx.treffer.swapped)) : null;
  out.auswahl = a;
  let best = null;
  if (a) {
    const pr = preise(ctx.zeile, a);
    out.fairAtReceipt = pr.fair;
    best = bestesNetzBuch(pr.buecher);
    out.best = best;
    const alle = Object.keys(pr.buecher).map((bk) => ({ book: bk, odds: pr.buecher[bk] })).sort((x, y) => y.odds - x.odds);
    out.bestAll = alle[0] || null;
    if (best && pr.fair > 1) { out.boardEdgePct = Math.round((best.odds / pr.fair - 1) * 10000) / 100; out.unique = (best.odds / pr.fair - 1) < KANTE_SCHON_DA; }
  }
  const alter = ctx.receivedTs - (n(p.tsCreated) || ctx.receivedTs);
  if (ctx.maxAgeMs && alter > ctx.maxAgeMs) { out.reason = "stale signal"; return out; }
  if (!ctx.zeile) { out.reason = "no executable book odds / no match"; out.matchNote = ctx.treffer && ctx.treffer.grund || null; return out; }
  if (!a) { out.reason = "market not scored yet"; return out; }
  if (!best) { out.reason = "no executable book odds / no match"; return out; }
  if (best.odds < (n(p.minOdds) || 0)) { out.reason = "line moved below originator minOdds"; return out; }
  out.executable = true;
  if (n(p.fairOdds) > 1) out.evRealPct = Math.round((best.odds / Number(p.fairOdds) - 1) * 10000) / 100;
  return out;
}

// Schlusskurs ohne Marge für die Auswahl aus einem Schluss-Eintrag ({ f, ah:[[L, a, b]], tot:[[L, o, u]] }).
function schlussFair(schluss, a) {
  if (!schluss || !a) return null;
  if (a.markt === "1x2") return n(schluss.f && schluss.f[IX[a.seite]]);
  const e = linie(a.markt === "ah" ? schluss.ah : schluss.tot, a.linie);
  return e ? n(e[(a.seite === "home" || a.seite === "over") ? 1 : 2]) : null;
}
function clvPct(odds, schlussFairQuote) { const o = n(odds), c = n(schlussFairQuote); if (!(o > 1) || !(c > 1)) return null; return Math.round((o / c - 1) * 10000) / 100; }

// Ergebnis aus Endstand (Sicht der Board-Zeile: heim = zeile.h). Viertel-Linien werden geteilt.
function halbe(d) { return d > 0 ? 1 : d < 0 ? -1 : 0; }
function kombi(x, y) {
  const s = x + y;
  if (s === 2) return "WIN"; if (s === -2) return "LOSS"; if (s === 0 && x === 0) return "PUSH";
  if (s === 1) return "HALF_WIN"; if (s === -1) return "HALF_LOSS"; return "PUSH";
}
function linienErgebnis(diffOhne, L) {   // diffOhne = Vorsprung der gewählten Seite ohne Linie; L = Linie dieser Seite
  const q = Math.round(L * 4);
  if (Math.abs(q % 2) === 1) return kombi(halbe(diffOhne + (L - 0.25)), halbe(diffOhne + (L + 0.25)));
  const d = diffOhne + L; return d > 0 ? "WIN" : d < 0 ? "LOSS" : "PUSH";
}
// sportZeile = "soccer" | "basketball" …; zweiWege = Sieger-Markt ohne Remis (ml).
function ergebnis(a, heim, gast, opt) {
  const h = n(heim), g = n(gast); if (h == null || g == null || !a) return null;
  const sport = (opt && opt.sport) || "soccer", zweiWege = !!(opt && opt.zweiWege);
  if (sport !== "soccer" && sport !== "basketball") return null;   // Tennis/eSports: Endstand der Quelle hier nicht eindeutig
  if (sport === "basketball" && h === g) return null;              // Periode 0 unentschieden = Stand vor Verlängerung → nicht werten
  if (a.markt === "1x2") {
    if (zweiWege && h === g) return null;
    const w = a.seite === "1" ? h > g : a.seite === "2" ? g > h : h === g;
    return w ? "WIN" : "LOSS";
  }
  if (a.markt === "ah") return linienErgebnis(a.seite === "home" ? h - g : g - h, a.seite === "home" ? a.linie : -a.linie);
  if (a.markt === "tot") return linienErgebnis(a.seite === "over" ? (h + g) : -(h + g), a.seite === "over" ? -a.linie : a.linie);
  return null;
}
function gewinn(res, odds) {
  const o = n(odds); if (!res || !(o > 1)) return null;
  return { WIN: o - 1, HALF_WIN: (o - 1) / 2, PUSH: 0, VOID: 0, HALF_LOSS: -0.5, LOSS: -1 }[res] ?? null;
}

module.exports = { NETZ_BUECHER, KANTE_SCHON_DA, auswahl, preise, bestesNetzBuch, beiEmpfang, schlussFair, clvPct, ergebnis, gewinn, linienErgebnis };
