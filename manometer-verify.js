#!/usr/bin/env node
"use strict";
// manometer-verify — check a Manometer scorecard bundle without trusting Manometer's servers.
//
//   node manometer-verify.js receipts <bundle.json>   signatures, payload fingerprints, anchors (OpenTimestamps)
//   node manometer-verify.js seals    <bundle.json>   each ciphertext opens at its drand round, not before, to the published proposal
//   node manometer-verify.js prices   <bundle.json>   market-at-receipt proofs, closing-line proofs, CLV recomputed
//   node manometer-verify.js results  <bundle.json>   results recomputed from the final score, paper P&L recomputed
//   node manometer-verify.js all      <bundle.json>   everything above + the bundle root
//
// Options: --offline (no network: drand beacons and Bitcoin headers are not fetched independently)
//          --esplora <url> (Bitcoin block explorer API, default https://blockstream.info/api)
// Exit code 0 = everything checked out, 1 = at least one mismatch, 2 = usage / unreadable bundle.
// Everything this program needs is in ./lib (the same code the referee runs) and in the bundle itself.
const fs = require("fs"), path = require("path");
const L = path.join(__dirname, "lib");
const { kanon, sha256Hex } = require(path.join(L, "kanon.js"));
const merkle = require(path.join(L, "merkle.js"));
const { pruefeSignatur } = require(path.join(L, "schluessel.js"));
const DRAND = require(path.join(L, "drand.js"));
const SIEGEL = require(path.join(L, "siegel.js"));
const OTS = require(path.join(L, "ots.js"));
const SNAP = require(path.join(L, "schnappschuss.js"));
const BEW = require(path.join(L, "bewertung.js"));
const FC = require(path.join(L, "feed-core.js"));

function argWert(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }
function optionen(o) { return Object.assign({ offline: process.argv.includes("--offline"), esplora: argWert("--esplora") || "https://blockstream.info/api" }, o || {}); }

function bericht() {
  const r = { ok: 0, fehler: [], hinweise: [] };
  return Object.assign(r, { gut() { r.ok++; }, schlecht(t) { r.fehler.push(t); }, hinweis(t) { r.hinweise.push(t); } });
}
function rd2(x) { return x == null ? null : Math.round(x * 100) / 100; }
function gleichZahl(a, b, tol) { if (a == null && b == null) return true; if (a == null || b == null) return false; return Math.abs(a - b) <= (tol || 0.011); }

function ridVon(q) { const c = Object.assign({}, q); delete c.sig; delete c.keyId; delete c.rid; return "r_" + sha256Hex(kanon(c)).slice(0, 24); }
function blatt(obj) { return merkle.blattHash(kanon(obj)).toString("hex"); }
function ankerOk(b, obj, beweis, R, was) {
  if (!beweis) return false;
  const a = (b.anker || []).find((x) => x.id === beweis.anker);
  if (!a) { R.schlecht(was + ": anchor " + beweis.anker + " missing from the bundle"); return false; }
  if (a.wurzel !== beweis.wurzel) { R.schlecht(was + ": anchor root differs"); return false; }
  if (!merkle.pruefeHash(blatt(obj), beweis.index, beweis.n, beweis.pfad, beweis.wurzel)) { R.schlecht(was + ": Merkle path to anchor " + a.id + " invalid"); return false; }
  return true;
}

async function pruefeReceipts(b, R, opts) {
  const o = optionen(opts);
  const pub = b.referee && b.referee.publicKey;
  for (const e of b.eintraege) {
    const q = e.quittung, was = "receipt " + (q && q.rid);
    if (!pruefeSignatur(q, pub)) { R.schlecht(was + ": signature invalid"); continue; }
    if (ridVon(q) !== q.rid) { R.schlecht(was + ": rid does not match its content"); continue; }
    if (q.sourceId !== b.sourceId) { R.schlecht(was + ": belongs to source " + q.sourceId); continue; }
    if (q.sealed) { if (!e.siegel || sha256Hex(e.siegel) !== q.payloadSha256) { R.schlecht(was + ": ciphertext fingerprint differs"); continue; } }
    else if (!e.vorschlag || sha256Hex(kanon(e.vorschlag)) !== q.payloadSha256) { R.schlecht(was + ": proposal fingerprint differs"); continue; }
    R.gut();
    if (e.ankerQuittung) { if (ankerOk(b, q, e.ankerQuittung, R, was)) R.gut(); }
    else R.hinweis(was + ": not anchored yet (anchors run hourly)");
  }
  for (const a of b.anker || []) {
    let d; try { d = OTS.leseDatei(Buffer.from(a.ots, "base64")); } catch (err) { R.schlecht("anchor " + a.id + ": .ots unreadable (" + err.message + ")"); continue; }
    if (d.digest.toString("hex") !== a.wurzel) { R.schlecht("anchor " + a.id + ": .ots digest is not the anchor root"); continue; }
    const btc = OTS.bescheinigungen(d.knoten).filter((x) => x.typ === "bitcoin");
    if (!btc.length) { R.hinweis("anchor " + a.id + ": pending in Bitcoin (calendar promise only)"); R.gut(); continue; }
    if (o.offline) { R.hinweis("anchor " + a.id + ": Bitcoin block " + btc.map((x) => x.hoehe).join(",") + " (not fetched, --offline)"); R.gut(); continue; }
    let eins = false;
    for (const x of btc) { try { const p = await OTS.pruefeBitcoin(x, { esplora: o.esplora }); if (p.ok) { eins = true; R.hinweis("anchor " + a.id + ": in Bitcoin block " + p.hoehe + " (" + new Date(p.zeit).toISOString() + ")"); break; } } catch (_) {} }
    if (eins) R.gut(); else R.schlecht("anchor " + a.id + ": Bitcoin attestation does not match the block header");
  }
}

async function pruefeSeals(b, R, opts) {
  const o = optionen(opts);
  const jetzt = Date.now();
  for (const e of b.eintraege) {
    const q = e.quittung; if (!q.sealed) continue;
    const was = "seal " + q.rid;
    let k; try { k = SIEGEL.kopf(e.siegel); } catch (err) { R.schlecht(was + ": " + err.message); continue; }
    if (!q.drand || k.runde !== q.drand.round || DRAND.rundeZeit(k.runde) !== q.drand.opensTs) { R.schlecht(was + ": drand round in the receipt differs from the ciphertext"); continue; }
    if (q.drand.opensTs <= q.receivedTs) { R.schlecht(was + ": seal was already open when received"); continue; }
    if (e.oeffnung.zustand === "sealed") {
      if (q.drand.opensTs <= jetzt - 120000) R.schlecht(was + ": round " + k.runde + " has passed but the bundle shows the seal unopened");
      else { R.hinweis(was + ": opens " + new Date(q.drand.opensTs).toISOString() + " (round " + k.runde + ")"); R.gut(); }
      continue;
    }
    if (!e.beacon || e.beacon.round !== k.runde) { R.schlecht(was + ": beacon missing or for the wrong round"); continue; }
    if (!o.offline) {
      try { const ext = await DRAND.holeBeacon(k.runde); if (ext.signature !== e.beacon.signature) { R.schlecht(was + ": beacon differs from public drand"); continue; } } catch (err) { R.hinweis(was + ": drand not reachable (" + err.message + "), using the beacon in the bundle"); }
    }
    let text; try { text = await SIEGEL.oeffne(e.siegel, e.beacon.signature); } catch (err) {
      if (e.oeffnung.zustand === "invalid_seal") { R.gut(); continue; }
      R.schlecht(was + ": does not open with the round's beacon"); continue;
    }
    let p = null; try { p = JSON.parse(text); } catch (_) {}
    if (e.oeffnung.zustand === "invalid_seal") { if (p && typeof p === "object" && !Array.isArray(p)) R.schlecht(was + ": opens to a JSON object but is marked invalid"); else R.gut(); continue; }
    if (!p || kanon(p) !== kanon(e.vorschlag)) { R.schlecht(was + ": opened content differs from the published proposal"); continue; }
    const ko = (e.markt && e.markt.zeile && e.markt.zeile.ko) || Number(p.eventIdentity && p.eventIdentity.startsTs) || null;
    const frueh = ko && q.drand.opensTs < ko - 60000;
    if (frueh && e.oeffnung.zustand !== "early_seal") { R.schlecht(was + ": opens before kick-off but is not marked early_seal"); continue; }
    if (!frueh && e.oeffnung.zustand === "early_seal") { R.schlecht(was + ": marked early_seal although it opens at kick-off"); continue; }
    R.gut();
  }
}

function auswahlVon(e) { return BEW.auswahl(e.vorschlag || {}, !!(e.treffer && e.treffer.swapped)); }
function pruefePrices(b, R) {
  const netz = (b.regeln && b.regeln.netzBuecher) || BEW.NETZ_BUECHER;
  const clvs = [];
  for (const e of b.eintraege) {
    if (!e.wertung) continue;
    const q = e.quittung, w = e.wertung, was = "prices " + q.rid;
    if (e.markt) {
      if (!SNAP.pruefeBeweis(e.markt)) { R.schlecht(was + ": market row proof invalid"); continue; }
      if (e.markt.wurzel !== q.snapshot.root || e.markt.n !== q.snapshot.n || e.markt.snapshot !== q.snapshot.id) { R.schlecht(was + ": market row is not from the snapshot in the signed receipt"); continue; }
      const a = auswahlVon(e);
      if (a && w.auswahl && kanon(a) !== kanon(w.auswahl)) { R.schlecht(was + ": selection mapping differs"); continue; }
      if (a) {
        const pr = BEW.preise(e.markt.zeile, a);
        let best = null; for (const bk of netz) { const v = pr.buecher[bk]; if (v > 1 && (!best || v > best.odds)) best = { book: bk, odds: v }; }
        if (!gleichZahl(pr.fair, w.fairAtReceipt, 1e-9)) { R.schlecht(was + ": fair at receipt " + pr.fair + " ≠ " + w.fairAtReceipt); continue; }
        if (!!best !== !!w.best || (best && (best.odds !== w.best.odds))) { R.schlecht(was + ": best executable price differs"); continue; }
        if (w.executable && best && best.odds < Number(e.vorschlag.minOdds)) { R.schlecht(was + ": counted executable below the source's minOdds"); continue; }
      }
    } else if (w.executable) { R.schlecht(was + ": executable without a market proof"); continue; }
    if (w.executable) {
      const v = FC.feedValidateProposal(e.vorschlag, q.receivedTs);
      if (!v.ok) { R.schlecht(was + ": counted executable but the proposal fails contract v1 at receipt (" + v.errors.join("; ") + ")"); continue; }
    }
    if (e.schluss) {
      if (e.ankerSchluss) { if (!ankerOk(b, e.schluss, e.ankerSchluss, R, was + " closing")) continue; }
      else R.hinweis(was + ": closing line not anchored yet");
      if (e.markt && (e.schluss.k !== e.markt.zeile.k || e.schluss.ko !== e.markt.zeile.ko)) { R.schlecht(was + ": closing line belongs to another game"); continue; }
      const c = w.best ? BEW.clvPct(w.best.odds, BEW.schlussFair(e.schluss, w.auswahl)) : null;
      if (!gleichZahl(c, w.clvPct, 0.001)) { R.schlecht(was + ": CLV " + w.clvPct + " ≠ recomputed " + c); continue; }
      if (w.executable && c != null) clvs.push(c);
    }
    R.gut();
  }
  const sc = b.scorecard && b.scorecard.gesamt;
  if (sc) {
    const avg = clvs.length ? rd2(clvs.reduce((s, x) => s + x, 0) / clvs.length) : null;
    if (!gleichZahl(avg, sc.avgClvPct, 0.011)) R.schlecht("scorecard: average CLV " + sc.avgClvPct + " ≠ recomputed " + avg);
    else { R.gut(); R.hinweis("CLV recomputed: " + (avg == null ? "—" : (avg >= 0 ? "+" : "") + avg + " %") + " over " + clvs.length + " proposals (matches)"); }
  }
}

function pruefeResults(b, R) {
  let n = 0, summe = 0;
  for (const e of b.eintraege) {
    const w = e.wertung; if (!w || !e.ergebnis) continue;
    const was = "result " + e.quittung.rid;
    if (e.ankerErgebnis) { if (!ankerOk(b, e.ergebnis, e.ankerErgebnis, R, was)) continue; }
    else R.hinweis(was + ": result not anchored yet");
    if (e.markt && e.ergebnis.pe !== e.markt.zeile.pe) { R.schlecht(was + ": result belongs to another event"); continue; }
    const a = w.auswahl;
    const res = e.ergebnis.void ? "VOID" : BEW.ergebnis(a, e.ergebnis.h, e.ergebnis.g, { sport: e.markt && e.markt.zeile.s, zweiWege: e.vorschlag && e.vorschlag.mkt === "ml" });
    if (res !== w.ergebnis) { R.schlecht(was + ": result " + w.ergebnis + " ≠ recomputed " + res + " (" + e.ergebnis.h + ":" + e.ergebnis.g + ")"); continue; }
    const g = w.executable && w.best ? BEW.gewinn(res, w.best.odds) : null;
    if (!gleichZahl(g, w.gewinn, 1e-9)) { R.schlecht(was + ": paper profit differs"); continue; }
    if (g != null) { n++; summe += g; }
    R.gut();
  }
  const sc = b.scorecard && b.scorecard.gesamt;
  if (sc) {
    const y = n ? Math.round(summe / n * 1000) / 10 : null;
    if (!gleichZahl(y, sc.yieldPct, 0.051)) R.schlecht("scorecard: paper yield " + sc.yieldPct + " ≠ recomputed " + y);
    else { R.gut(); R.hinweis(n + " settled · paper yield " + (y == null ? "—" : y + " %") + " (matches)"); }
  }
}

function pruefeWurzel(b, R) {
  const w = merkle.baum(b.eintraege.map((x) => kanon(x))).wurzel;
  if (w !== b.wurzel) R.schlecht("bundle root " + b.wurzel + " ≠ recomputed " + w); else { R.gut(); R.hinweis("bundle root sha256:" + w); }
}

async function main() {
  const was = process.argv[2], datei = process.argv[3];
  if (!["receipts", "seals", "prices", "results", "all"].includes(was) || !datei) {
    console.error("usage: manometer-verify <receipts|seals|prices|results|all> <bundle.json> [--offline] [--esplora URL]"); process.exit(2);
  }
  let b; try { b = JSON.parse(fs.readFileSync(datei, "utf8")); } catch (e) { console.error("cannot read bundle: " + e.message); process.exit(2); }
  if (!b || b.typ !== "manometer.scorecard-bundle" || !Array.isArray(b.eintraege)) { console.error("not a Manometer scorecard bundle"); process.exit(2); }
  const R = bericht();
  if (was === "receipts" || was === "all") await pruefeReceipts(b, R);
  if (was === "seals" || was === "all") await pruefeSeals(b, R);
  if (was === "prices" || was === "all") pruefePrices(b, R);
  if (was === "results" || was === "all") pruefeResults(b, R);
  if (was === "all") pruefeWurzel(b, R);
  console.log("source " + b.sourceId + " · " + b.eintraege.length + " proposals · referee key " + (b.referee && b.referee.keyId));
  for (const h of R.hinweise) console.log("  · " + h);
  for (const f of R.fehler) console.log("  ✗ " + f);
  console.log((R.fehler.length ? "FAILED" : "OK") + " — " + R.ok + " checks passed, " + R.fehler.length + " failed");
  process.exit(R.fehler.length ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
module.exports = { pruefeReceipts, pruefeSeals, pruefePrices, pruefeResults, pruefeWurzel, bericht, ridVon };
