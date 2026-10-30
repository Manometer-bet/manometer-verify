"use strict";
// lib/netz/drand.js — drand quicknet: Rundenzeit, Runde zu einem Zeitpunkt, Beacon holen (29.10.2026).
// quicknet = öffentliche Zufallskette der League of Entropy, alle 3 s eine Runde, BLS-Schema „unchained" (Voraussetzung
// für Zeitschloss-Verschlüsselung). Werte am 29.10.2026 von api.drand.sh/<hash>/info gelesen und hier fest verdrahtet:
// eine Kette mit anderem Hash wird abgelehnt.
// REIN bis auf holeBeacon (fetch wird übergeben); byte-gleich in netz-verify/lib/.
const QUICKNET = Object.freeze({
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  public_key: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesis_time: 1692803367,
  schemeID: "bls-unchained-g1-rfc9380",
  metadata: { beaconID: "quicknet" },
});
const ENDPUNKTE = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh", "https://api3.drand.sh"];

// Zeitpunkt (ms UTC), ab dem Runde r veröffentlicht ist.
function rundeZeit(r) { return (QUICKNET.genesis_time + (Number(r) - 1) * QUICKNET.period) * 1000; }
// Erste Runde, deren Zeit ≥ ts ist (Siegel öffnet frühestens zu ts). Konvention für Quellen: runde = rundeAb(Anstoß).
function rundeAb(tsMs) {
  const s = Number(tsMs) / 1000 - QUICKNET.genesis_time;
  let r = Math.ceil(s / QUICKNET.period) + 1;
  if (r < 1) r = 1;
  while (rundeZeit(r) < tsMs) r++;
  while (r > 1 && rundeZeit(r - 1) >= tsMs) r--;
  return r;
}
// Letzte Runde, die zu ts schon veröffentlicht war.
function rundeBis(tsMs) { return Math.max(1, Math.floor((Number(tsMs) / 1000 - QUICKNET.genesis_time) / QUICKNET.period) + 1); }

// Beacon von einem der öffentlichen Endpunkte holen. fetchFn = globales fetch oder Ersatz (Tests).
async function holeBeacon(runde, fetchFn, opts) {
  const f = fetchFn || (typeof fetch === "function" ? fetch : null);
  if (!f) throw new Error("kein fetch");
  const urls = (opts && opts.endpunkte) || ENDPUNKTE;
  let letzter = null;
  for (const u of urls) {
    try {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), (opts && opts.fristMs) || 8000) : null;
      const r = await f(u + "/" + QUICKNET.hash + "/public/" + Number(runde), ctl ? { signal: ctl.signal } : undefined);
      if (t) clearTimeout(t);
      if (!r.ok) { letzter = new Error(u + " HTTP " + r.status); continue; }
      const j = await r.json();
      if (!j || Number(j.round) !== Number(runde) || !/^[0-9a-f]{96}$/i.test(String(j.signature || ""))) { letzter = new Error(u + " unerwartete Antwort"); continue; }
      return { round: Number(j.round), signature: String(j.signature).toLowerCase(), randomness: j.randomness || null, quelle: u };
    } catch (e) { letzter = e; }
  }
  throw letzter || new Error("kein Endpunkt erreichbar");
}

module.exports = { QUICKNET, ENDPUNKTE, rundeZeit, rundeAb, rundeBis, holeBeacon };
