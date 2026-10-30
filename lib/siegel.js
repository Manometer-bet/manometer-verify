"use strict";
// lib/netz/siegel.js — Zeitschloss (tlock, drand quicknet): versiegeln, Kopf lesen, öffnen (29.10.2026).
// Ein Siegel ist eine age-Datei (ASCII-Armor) mit genau EINEM Empfänger-Abschnitt „-> tlock <Runde> <Ketten-Hash>".
// Der Dateischlüssel ist per Identitäts-Verschlüsselung an die drand-Runde gebunden: öffnen kann ihn erst, wer die
// BLS-Signatur dieser Runde hat — und die veröffentlicht drand erst zur Rundenzeit. Vorher kann niemand öffnen,
// auch der Dienst nicht. Danach jeder.
// Öffnen geht hier NICHT über timelockDecrypt von tlock-js: das holt den Beacon selbst übers Netz, prüft gegen die
// Uhr und schreibt den Beacon ins Log. Stattdessen wird der Beacon übergeben (Dienst: holeBeacon; Prüfprogramm: eigener
// Abruf; Tests: festgehaltene echte Beacons). Eine falsche Signatur lässt die MAC-Prüfung von age scheitern — gelingt
// das Öffnen, war der Beacon der richtige.
// Byte-gleich in netz-verify/lib/.
const T = require("tlock-js");
const { decryptAge } = require("tlock-js/age/age-encrypt-decrypt");
const { decodeArmor, isProbablyArmored } = require("tlock-js/age/armor");
const ibe = require("tlock-js/crypto/ibe");
const { bls12_381 } = require("@noble/curves/bls12-381");
const { QUICKNET } = require("./drand.js");

const MAX_SIEGEL = 32 * 1024;   // Zeichen; ein Vorschlag (~1 KB JSON) ergibt ~1,6 KB Armor
const STATISCHE_KETTE = { chain: () => ({ info: async () => QUICKNET }) };   // Verschlüsseln braucht nur den öffentlichen Ketten-Schlüssel

async function versiegle(text, runde) {
  if (!(Number(runde) >= 1)) throw new Error("Runde ungültig");
  return T.timelockEncrypt(Number(runde), Buffer.from(String(text), "utf8"), STATISCHE_KETTE);
}

// Kopf lesen ohne zu öffnen: { runde, kette }. Wirft bei allem, was kein einzelnes quicknet-tlock-Siegel ist.
function kopf(siegel) {
  const s = String(siegel || "");
  if (!s || s.length > MAX_SIEGEL) throw new Error("Siegel fehlt oder zu groß");
  const bin = isProbablyArmored(s) ? decodeArmor(s) : s;
  const zeilen = bin.split("\n");
  if (zeilen[0] !== "age-encryption.org/v1") throw new Error("kein age-v1-Siegel");
  const stanzas = [];
  for (let i = 1; i < zeilen.length; i++) {
    const z = zeilen[i];
    if (z.startsWith("---")) break;
    if (z.startsWith("-> ")) stanzas.push(z.slice(3).split(" "));
  }
  if (stanzas.length !== 1) throw new Error("genau ein Empfänger erwartet, gefunden " + stanzas.length);
  const [typ, rundeS, kette] = stanzas[0];
  if (typ !== "tlock" || stanzas[0].length !== 3) throw new Error("kein tlock-Empfänger");
  if (!/^\d{1,15}$/.test(rundeS)) throw new Error("Runde unlesbar");
  if (kette !== QUICKNET.hash) throw new Error("falsche drand-Kette (nur quicknet)");
  return { runde: Number(rundeS), kette };
}

function teileChiffrat(body) {   // wie tlock-js timelock-decrypter parseCiphertext (G2-Punkt U, dann V und W je zur Hälfte)
  const n = bls12_381.G2.ProjectivePoint.BASE.toRawBytes(true).byteLength;
  const rest = body.subarray(n), halb = rest.length / 2;
  return { U: body.subarray(0, n), V: rest.subarray(0, halb), W: rest.subarray(halb) };
}

// Öffnen mit dem Beacon der Runde (signaturHex = 96 Hex-Zeichen). Gibt den Klartext (UTF-8) zurück.
async function oeffne(siegel, signaturHex) {
  const k = kopf(siegel);
  const s = String(siegel);
  const bin = isProbablyArmored(s) ? decodeArmor(s) : s;
  const klar = await decryptAge(bin, async (empfaenger) => {
    const st = (empfaenger || []).find((e) => e && e.type === "tlock");
    if (!st || !st.args || Number(st.args[0]) !== k.runde) throw new Error("tlock-Abschnitt fehlt");
    return ibe.decryptOnG2(Buffer.from(String(signaturHex), "hex"), teileChiffrat(Buffer.from(st.body)));
  });
  return Buffer.from(klar).toString("utf8");
}

module.exports = { versiegle, kopf, oeffne, MAX_SIEGEL };
