"use strict";
// lib/netz/schnappschuss.js — Markt-Schnappschuss beim Empfang (29.10.2026).
// Bewertet wird IMMER zum Empfangszeitpunkt, nie zum Zeitstempel des Lieferanten. Weil ein versiegelter Vorschlag erst
// zum Anstoß lesbar wird, kennt der Schiedsrichter beim Empfang weder Spiel noch Tipp — also wird der GANZE Vorspiel-
// Markt dieser Sekunde festgehalten: je Board-Zeile Fair (Pinnacle ohne Marge), die Quoten aller Bücher für 1X2/Sieger
// und die Handicap-/Total-Linien, für die es eine Fair gibt. Die Zeilen werden kanonisch sortiert und bilden einen
// Merkle-Baum; dessen Wurzel steht in der signierten Quittung. Nach dem Öffnen braucht ein Prüfer nur die EINE Zeile
// samt Pfad — der ganze Schnappschuss kann dann weg (Aufbewahrung regelt referee.js).
// REIN (Zeilen rein, Objekt raus); Namensvergleich über die übergebene live-core-API (lc), damit dieselben Regeln gelten
// wie im Board.
const { kanon, sha256Hex } = require("./kanon.js");
const merkle = require("./merkle.js");

const SPORT_FEED = { fb: "soccer", basket: "basketball", tennis: "tennis", cs2: "esports" };
const ANSTOSS_FENSTER_MS = 3 * 3600e3;   // Vorschlag und Zeile dürfen so weit auseinander liegen (Anstoß-Verschiebungen)

function zahl(x) { const n = Number(x); return isFinite(n) && n > 1 ? Math.round(n * 10000) / 10000 : null; }
function zeitNum(x) { const n = Number(x); return isFinite(n) && n > 0 ? n : null; }
// GESTALT (kanonisch schon durch den Aufbau: Objekt-Schlüssel in sortierter Reihenfolge, alles Variable als Arrays) —
// dadurch ist JSON.stringify(zeile) === kanon(zeile) und der Schnappschuss kostet ein Drittel der Zeit (gemessen 29.10.:
// 1458 Zeilen, kanon 51 ms gegen stringify). Ein Test hält die Gleichheit fest.
//   { a, ah:[[Linie, fairHeim, fairGast, [[buch, heim, gast], …]], …]|null, b:[[buch, q1, qX, q2, ts], …],
//     f:[f1, fX, f2]|null, fs, h, k, ko, l, pe, s, tot:[[Linie, fairOver, fairUnder, [[buch, over, under], …]], …]|null }
// Linien aufsteigend, Bücher alphabetisch. Fehlende Quote = null.
function leiter(cmp, seiten, mitBuechern) {
  if (!cmp || !cmp.fair) return null;
  const fk = cmp.fair.byLine || cmp.fair.byPoints; if (!fk) return null;
  const linien = Object.keys(fk).map((L) => [Number(L), L]).filter((x) => isFinite(x[0])).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [Ln, L] of linien) {
    const fr = fk[L]; const fa = zahl(fr && fr[seiten[0]]), fb = zahl(fr && fr[seiten[1]]);
    if (!fa || !fb) continue;
    if (!mitBuechern) { out.push([Ln, fa, fb]); continue; }
    const bu = [];
    for (const bk of Object.keys(cmp.books || {}).sort()) {
      const bl = cmp.books[bk]; const m = bl && (bl.byLine || bl.byPoints); const r = m && m[L];
      const x = zahl(r && r[seiten[0]]), y = zahl(r && r[seiten[1]]);
      if (x || y) bu.push([bk, x, y]);
    }
    out.push([Ln, fa, fb, bu]);
  }
  return out.length ? out : null;
}
function fair3(f) { if (!f) return null; const a = zahl(f["1"]), x = zahl(f.X), b = zahl(f["2"]); return (a || x || b) ? [a, x, b] : null; }

function kompaktZeile(row) {
  const b = [];
  for (const bk of Object.keys(row.books || {}).sort()) {
    const c = row.books[bk]; const o = c && c.o; if (!o) continue;
    const q1 = zahl(o["1"]), qx = zahl(o.X), q2 = zahl(o["2"]);
    if (q1 || qx || q2) b.push([bk, q1, qx, q2, zeitNum(c.ts)]);
  }
  return { a: String(row.away || ""), ah: leiter(row.ah, ["home", "away"], true), b, f: fair3(row.fair), fs: row.fairSrc || null,
    h: String(row.home || ""), k: String(row.key || ""), ko: zeitNum(row.kickoff), l: String(row.league || ""),
    pe: row.podEid != null ? String(row.podEid) : null, s: String(row.sport || "soccer"), tot: leiter(row.tot, ["over", "under"], true) };
}
// Nur die Fair (für den Schlusskurs): { f, ah:[[L, h, a]], tot:[[L, o, u]] }
function nurFair(row, fairObj) { return { ah: leiter(row.ah, ["home", "away"], false), f: fair3(fairObj || row.fair), tot: leiter(row.tot, ["over", "under"], false) }; }

// Schnappschuss aus den Board-Zeilen: nur Vorspiel (nicht live, Anstoß in der Zukunft) und nur Zeilen mit Fair.
function baue(rows, ts) {
  const jetzt = Number(ts) || Date.now();
  const zeilen = [];
  for (const r of rows || []) {
    if (!r || r.live || !(Number(r.kickoff) > jetzt) || !r.fair) continue;
    zeilen.push(kompaktZeile(r));
  }
  zeilen.sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : (x.ko || 0) - (y.ko || 0)));
  const blaetter = zeilen.map((z) => JSON.stringify(z));   // == kanon(z), s. GESTALT
  const t = merkle.baum(blaetter);
  return { v: 1, id: "snap_" + jetzt + "_" + t.wurzel.slice(0, 12), ts: jetzt, n: zeilen.length, wurzel: t.wurzel, zeilen, _baum: t };
}
// Beweis für Zeile i (Daten + Pfad), wie er ins Bundle geht.
function beweis(snap, i) {
  const t = snap._baum || merkle.baum(snap.zeilen.map((z) => kanon(z)));
  return { snapshot: snap.id, ts: snap.ts, wurzel: snap.wurzel, n: snap.n, index: i, zeile: snap.zeilen[i], pfad: t.pfad(i) };
}
function pruefeBeweis(bw) { return !!bw && merkle.pruefe(kanon(bw.zeile), bw.index, bw.n, bw.pfad, bw.wurzel); }

// Zeile zum Vorschlag finden. Reihenfolge: Pinnacle-Nummer (eventIdentity.pinId) exakt → Namensvergleich (live-core)
// innerhalb ±3 h um den behaupteten Anstoß. Zwei fast gleich gute Kandidaten = mehrdeutig = kein Treffer (bekannter Bug
// 29.10.: gleiche Vereins-Präfixe am selben Tag). Rückgabe { index, swapped, wie } oder { index:-1, grund }.
function finde(snap, p, lc) {
  const ei = (p && p.eventIdentity) || {};
  const sport = SPORT_FEED[p && p.sport] || null;
  const zeilen = (snap && snap.zeilen) || [];
  if (ei.pinId != null && String(ei.pinId) !== "") {
    const i = zeilen.findIndex((z) => z.pe === String(ei.pinId));
    if (i >= 0) {
      const z = zeilen[i]; const m = lc ? lc.lcFixtureMatch(ei.home, ei.away, z.h, z.a, { sport: z.s }) : { ok: true, swapped: false };
      if (m && m.ok) return { index: i, swapped: !!m.swapped, wie: "pinId" };
      return { index: -1, grund: "pinId " + ei.pinId + " belongs to a different game on the board" };
    }
  }
  const start = Number(ei.startsTs) || 0;
  const kand = [];
  zeilen.forEach((z, i) => {
    if (sport && z.s !== sport) return;
    if (start && z.ko && Math.abs(z.ko - start) > ANSTOSS_FENSTER_MS) return;
    const m = lc ? lc.lcFixtureMatch(ei.home, ei.away, z.h, z.a, { sport: z.s }) : null;
    if (m && m.ok) kand.push({ i, swapped: !!m.swapped, score: Number(m.score) || 0, dko: Math.abs((z.ko || 0) - start) });
  });
  if (!kand.length) return { index: -1, grund: "no match on the board" };
  kand.sort((a, b) => b.score - a.score || a.dko - b.dko);
  const best = kand[0], zweit = kand[1];
  if (zweit && zeilen[zweit.i].k !== zeilen[best.i].k && zweit.score >= best.score - 0.1) return { index: -1, grund: "ambiguous match (" + zeilen[best.i].h + " – " + zeilen[best.i].a + " / " + zeilen[zweit.i].h + " – " + zeilen[zweit.i].a + ")" };
  return { index: best.i, swapped: best.swapped, wie: "name" };
}

function fingerabdruck(snap) { return sha256Hex(kanon({ id: snap.id, ts: snap.ts, wurzel: snap.wurzel, n: snap.n })); }

module.exports = { SPORT_FEED, kompaktZeile, nurFair, fair3, baue, beweis, pruefeBeweis, finde, fingerabdruck };
