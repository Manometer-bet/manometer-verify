"use strict";
// lib/netz/kanon.js — kanonisches JSON + SHA-256 (Netzwerk-Schiedsrichter, 29.10.2026).
// Kanonisch = Schlüssel sortiert (UTF-16-Reihenfolge wie Array.sort), keine Leerzeichen, undefined-Felder fallen weg,
// Zahlen wie JSON.stringify. Dieselbe Form wie engine/engine-core.js canonicalJson, damit Signaturen, Fingerabdrücke und
// Merkle-Blätter überall gleich gerechnet werden — im Dienst, im Prüfprogramm (netz-verify/) und in fremdem Code.
// Diese Datei ist REIN (nur node:crypto) und wird byte-gleich nach netz-verify/lib/ kopiert (Test prüft das).
const crypto = require("crypto");

function kanon(v) {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !isFinite(v)) return "null";
    return JSON.stringify(v === undefined ? null : v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : kanon(x))).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + kanon(v[k])).join(",") + "}";
}
function sha256(x) { return crypto.createHash("sha256").update(typeof x === "string" ? Buffer.from(x, "utf8") : x).digest(); }
function sha256Hex(x) { return sha256(x).toString("hex"); }
// Ein Objekt ohne ein Feld (z. B. "sig") kanonisch — Grundlage jeder Signatur.
function ohne(obj, feld) { const c = Object.assign({}, obj); delete c[feld]; return c; }

module.exports = { kanon, sha256, sha256Hex, ohne };
