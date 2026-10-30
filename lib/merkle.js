"use strict";
// lib/netz/merkle.js — Merkle-Baum nach RFC 6962 / RFC 9162 (Certificate Transparency), 29.10.2026.
// Blatt-Hash = SHA-256(0x00 ‖ Daten), Knoten-Hash = SHA-256(0x01 ‖ links ‖ rechts), leerer Baum = SHA-256("").
// Bei n Blättern wird an der größten Zweierpotenz k < n geteilt — keine verdoppelten Blätter, also keine zweite Lesart
// desselben Baums. Beweis = Prüfpfad (Liste der Geschwister-Hashes von unten nach oben). Fremde Prüfer können das ohne
// unseren Code nachbauen; der Standard ist öffentlich.
// REIN (nur node:crypto), byte-gleich nach netz-verify/lib/ kopiert.
const crypto = require("crypto");

function H(...teile) { const h = crypto.createHash("sha256"); for (const t of teile) h.update(t); return h.digest(); }
const NULL = Buffer.from([0]), EINS = Buffer.from([1]);
function blattHash(daten) { return H(NULL, Buffer.isBuffer(daten) ? daten : Buffer.from(String(daten), "utf8")); }
function knotenHash(l, r) { return H(EINS, l, r); }
function teil(n) { let k = 1; while (k * 2 < n) k *= 2; return k; }   // größte Zweierpotenz < n (n ≥ 2)

// Wurzel über Blatt-HASHES (Buffer[32]).
function wurzelAusHashes(hs) {
  if (!hs.length) return H(Buffer.alloc(0));
  if (hs.length === 1) return hs[0];
  const k = teil(hs.length);
  return knotenHash(wurzelAusHashes(hs.slice(0, k)), wurzelAusHashes(hs.slice(k)));
}
// Prüfpfad für Blatt m (0-basiert) über Blatt-HASHES.
function pfadAusHashes(m, hs) {
  if (hs.length <= 1) return [];
  const k = teil(hs.length);
  if (m < k) return pfadAusHashes(m, hs.slice(0, k)).concat([wurzelAusHashes(hs.slice(k))]);
  return pfadAusHashes(m - k, hs.slice(k)).concat([wurzelAusHashes(hs.slice(0, k))]);
}
// RFC 9162 §2.1.3.2: Prüfpfad gegen Wurzel prüfen.
function pruefePfad(blattH, index, groesse, pfad, wurzel) {
  if (!(index >= 0) || !(index < groesse)) return false;
  let fn = index, sn = groesse - 1, r = blattH;
  for (const p of pfad) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = knotenHash(p, r);
      if ((fn & 1) === 0) { while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } }
    } else r = knotenHash(r, p);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && Buffer.compare(r, wurzel) === 0;
}

// Bequeme Hex-Form: Blätter als Daten (String/Buffer), Wurzel + Pfade als Hex.
function baum(blaetter) {
  const hs = blaetter.map(blattHash);
  return {
    groesse: hs.length,
    wurzel: wurzelAusHashes(hs).toString("hex"),
    pfad: (i) => pfadAusHashes(i, hs).map((b) => b.toString("hex")),
    blattHash: (i) => hs[i].toString("hex"),
  };
}
function pruefe(blattDaten, index, groesse, pfadHex, wurzelHex) {
  try {
    return pruefePfad(blattHash(blattDaten), index, groesse, (pfadHex || []).map((x) => Buffer.from(x, "hex")), Buffer.from(String(wurzelHex), "hex"));
  } catch (_) { return false; }
}
function pruefeHash(blattHashHex, index, groesse, pfadHex, wurzelHex) {
  try {
    return pruefePfad(Buffer.from(blattHashHex, "hex"), index, groesse, (pfadHex || []).map((x) => Buffer.from(x, "hex")), Buffer.from(String(wurzelHex), "hex"));
  } catch (_) { return false; }
}

module.exports = { blattHash, knotenHash, wurzelAusHashes, pfadAusHashes, pruefePfad, baum, pruefe, pruefeHash };
