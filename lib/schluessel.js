"use strict";
// lib/netz/schluessel.js — Ed25519-Schlüssel des Schiedsrichters (29.10.2026).
// Quittungen werden mit Ed25519 signiert (asymmetrisch): jeder kann sie mit dem ÖFFENTLICHEN Schlüssel prüfen, niemand
// außer dem Dienst kann sie ausstellen. Bisher signierte die Remote-Setz-Engine mit HMAC-SHA256 und einem gemeinsamen
// Geheimnis (engine/engine-core.js) — das schützt den Weg zum Bettor, ist aber für Dritte nicht prüfbar.
// Der private Schlüssel liegt als PKCS#8-PEM mit Rechten 0600 im Datenordner (netz-daten/schluessel/) und verlässt den
// Rechner nie; er wird nie geloggt. Öffentlich: roher 32-Byte-Schlüssel (Base64) + keyId = erste 16 Hex von SHA-256(roh).
// pruefeSignatur() ist REIN und byte-gleich in netz-verify/lib/ (dort ohne Dateizugriff genutzt).
const crypto = require("crypto");
const { kanon, sha256Hex, ohne } = require("./kanon.js");

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");   // DER-Kopf für einen rohen Ed25519-Schlüssel

function rohAusPublic(pub) { return Buffer.from(pub.export({ format: "jwk" }).x, "base64url"); }
function publicAusRoh(rohB64) { return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(rohB64, "base64")]), format: "der", type: "spki" }); }
function keyIdAusRoh(rohB64) { return sha256Hex(Buffer.from(rohB64, "base64")).slice(0, 16); }

// Laden oder einmalig erzeugen. ordner = netz-daten/schluessel
function ladeOderErzeuge(ordner, fsMod) {
  const fs = fsMod || require("fs"), path = require("path");
  const datei = path.join(ordner, "referee-ed25519.pem");
  let priv;
  if (fs.existsSync(datei)) priv = crypto.createPrivateKey(fs.readFileSync(datei));
  else {
    fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
    const kp = crypto.generateKeyPairSync("ed25519");
    priv = kp.privateKey;
    fs.writeFileSync(datei, priv.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  }
  const pub = crypto.createPublicKey(priv);
  const rohB64 = rohAusPublic(pub).toString("base64");
  return {
    publicRohB64: rohB64,
    keyId: keyIdAusRoh(rohB64),
    publicPem: pub.export({ format: "pem", type: "spki" }).toString(),
    signiere: (obj) => signiereMit(priv, rohB64, obj),
  };
}

// Signatur über kanon(obj ohne "sig"); keyId wird VOR dem Signieren gesetzt (gehört zum signierten Inhalt).
function signiereMit(priv, rohB64, obj) {
  const o = Object.assign({}, obj, { keyId: keyIdAusRoh(rohB64) });
  delete o.sig;
  const sig = crypto.sign(null, Buffer.from(kanon(o), "utf8"), priv).toString("base64");
  return Object.assign(o, { sig });
}
function pruefeSignatur(obj, publicRohB64) {
  try {
    if (!obj || typeof obj.sig !== "string") return false;
    if (obj.keyId && obj.keyId !== keyIdAusRoh(publicRohB64)) return false;
    return crypto.verify(null, Buffer.from(kanon(ohne(obj, "sig")), "utf8"), publicAusRoh(publicRohB64), Buffer.from(obj.sig, "base64"));
  } catch (_) { return false; }
}

module.exports = { ladeOderErzeuge, signiereMit, pruefeSignatur, keyIdAusRoh, publicAusRoh, rohAusPublic };
