"use strict";
// lib/netz/ots.js — OpenTimestamps, schlanker eigener Client (29.10.2026).
// Wozu: Stündlich wird die Merkle-Wurzel aller neuen Quittungen (und Schlusskurse) bei öffentlichen OTS-Kalendern
// eingereicht. Die Kalender bündeln viele Einreichungen in EINE Bitcoin-Transaktion. Ergebnis: ein Beweis, dass es die
// Wurzel spätestens zur Zeit dieses Bitcoin-Blocks gab. Verschickt wird NUR der 32-Byte-Hash — kein Inhalt.
// Dateiformat = das offizielle .ots (python-opentimestamps): Magie, Version 1, Datei-Hash-Op (sha256), Digest, Zeitstempel-
// baum. Dadurch prüft auch das offizielle Programm (`ots verify`) unsere Dateien. Ops: sha256 (0x08), append (0xf0),
// prepend (0xf1); sha1/ripemd160/keccak/reverse/hexlify werden gelesen und — soweit Node sie kann — angewendet.
// Bescheinigungen: pending (Kalender-URI) und Bitcoin (Blockhöhe); unbekannte bleiben roh erhalten.
// Byte-gleich in netz-verify/lib/.
const crypto = require("crypto");

const MAGIE = Buffer.concat([Buffer.from([0x00]), Buffer.from("OpenTimestamps"), Buffer.from([0x00, 0x00]), Buffer.from("Proof"), Buffer.from([0x00]), Buffer.from("bf89e2e884e89294", "hex")]);
const TAG_PENDING = "83dfe30d2ef90c8e", TAG_BITCOIN = "0588960d73d71901", TAG_LITECOIN = "06869a0d73d71b45";
const KALENDER = ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org", "https://a.pool.eternitywall.com", "https://ots.btc.catallaxy.com"];
const OPS = { 0x02: "sha1", 0x03: "ripemd160", 0x08: "sha256", 0x67: "keccak256", 0xf0: "append", 0xf1: "prepend", 0xf2: "reverse", 0xf3: "hexlify" };
const OP_TAG = { sha1: 0x02, ripemd160: 0x03, sha256: 0x08, keccak256: 0x67, append: 0xf0, prepend: 0xf1, reverse: 0xf2, hexlify: 0xf3 };

// ---- Lesen / Schreiben -------------------------------------------------------------------
function leser(buf) {
  let pos = 0;
  const r = {
    byte() { if (pos >= buf.length) throw new Error("OTS: Ende der Daten"); return buf[pos++]; },
    bytes(n) { if (pos + n > buf.length) throw new Error("OTS: Ende der Daten"); const b = buf.subarray(pos, pos + n); pos += n; return Buffer.from(b); },
    varuint() { let v = 0, s = 0, b; do { b = r.byte(); v += (b & 0x7f) * Math.pow(2, s); s += 7; if (s > 56) throw new Error("OTS: varuint zu lang"); } while (b & 0x80); return v; },
    varbytes(max) { const n = r.varuint(); if (n > (max || 8192)) throw new Error("OTS: Feld zu groß"); return r.bytes(n); },
    rest() { return buf.length - pos; },
  };
  return r;
}
function varuint(v) { const o = []; if (v === 0) return Buffer.from([0]); while (v > 0) { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; o.push(b); } return Buffer.from(o); }
function varbytes(b) { return Buffer.concat([varuint(b.length), b]); }

function hashOp(name, msg) {
  if (name === "sha256") return crypto.createHash("sha256").update(msg).digest();
  if (name === "sha1") return crypto.createHash("sha1").update(msg).digest();
  if (name === "ripemd160") return crypto.createHash("ripemd160").update(msg).digest();   // wirft, wenn OpenSSL es nicht anbietet
  if (name === "keccak256") throw new Error("OTS: keccak256 nicht unterstützt");
  throw new Error("OTS: unbekannte Op " + name);
}
function wendeAn(op, msg) {
  if (op.name === "append") return Buffer.concat([msg, op.arg]);
  if (op.name === "prepend") return Buffer.concat([op.arg, msg]);
  if (op.name === "reverse") return Buffer.from(msg).reverse();
  if (op.name === "hexlify") return Buffer.from(msg.toString("hex"), "utf8");
  return hashOp(op.name, msg);
}
function leseOp(r, tag) {
  const name = OPS[tag]; if (!name) throw new Error("OTS: unbekanntes Op-Tag 0x" + tag.toString(16));
  if (name === "append" || name === "prepend") return { name, arg: r.varbytes(4096) };
  return { name };
}
function leseAttestierung(r) {
  const tag = r.bytes(8).toString("hex"), nutz = r.varbytes(8192), p = leser(nutz);
  if (tag === TAG_PENDING) return { typ: "pending", uri: p.varbytes(1000).toString("utf8") };
  if (tag === TAG_BITCOIN) return { typ: "bitcoin", hoehe: p.varuint() };
  if (tag === TAG_LITECOIN) return { typ: "litecoin", hoehe: p.varuint() };
  return { typ: "unbekannt", tag, roh: nutz.toString("hex") };
}
function schreibeAttestierung(a) {
  if (a.typ === "pending") return Buffer.concat([Buffer.from(TAG_PENDING, "hex"), varbytes(varbytes(Buffer.from(a.uri, "utf8")))]);
  if (a.typ === "bitcoin") return Buffer.concat([Buffer.from(TAG_BITCOIN, "hex"), varbytes(varuint(a.hoehe))]);
  if (a.typ === "litecoin") return Buffer.concat([Buffer.from(TAG_LITECOIN, "hex"), varbytes(varuint(a.hoehe))]);
  return Buffer.concat([Buffer.from(a.tag, "hex"), varbytes(Buffer.from(a.roh, "hex"))]);
}
function schreibeOp(op) { const t = Buffer.from([OP_TAG[op.name]]); return (op.name === "append" || op.name === "prepend") ? Buffer.concat([t, varbytes(op.arg)]) : t; }

// Knoten = { msg: Buffer, ops: [{ op, kind: Knoten }], att: [Attestierung] }
function leseKnoten(r, msg, tiefe) {
  if (tiefe <= 0) throw new Error("OTS: zu tief verschachtelt");
  const k = { msg, ops: [], att: [] };
  const tue = (tag) => {
    if (tag === 0x00) k.att.push(leseAttestierung(r));
    else { const op = leseOp(r, tag); k.ops.push({ op, kind: leseKnoten(r, wendeAn(op, msg), tiefe - 1) }); }
  };
  let tag = r.byte();
  while (tag === 0xff) { tue(r.byte()); tag = r.byte(); }
  tue(tag);
  return k;
}
function schreibeKnoten(k) {
  const zweige = [];
  for (const a of k.att) zweige.push(Buffer.concat([Buffer.from([0x00]), schreibeAttestierung(a)]));
  for (const o of k.ops) zweige.push(Buffer.concat([schreibeOp(o.op), schreibeKnoten(o.kind)]));
  if (!zweige.length) throw new Error("OTS: leerer Knoten");
  const teile = [];
  zweige.forEach((z, i) => { if (i < zweige.length - 1) teile.push(Buffer.from([0xff])); teile.push(z); });
  return Buffer.concat(teile);
}
function knotenAusAntwort(antwort, msg) { const r = leser(antwort); const k = leseKnoten(r, msg, 256); if (r.rest()) throw new Error("OTS: Daten nach dem Zeitstempel"); return k; }

// ---- Verschmelzen (mehrere Kalender, Aufwertung) -----------------------------------------
function gleicheOp(a, b) { return a.name === b.name && ((!a.arg && !b.arg) || (a.arg && b.arg && Buffer.compare(a.arg, b.arg) === 0)); }
function gleicheAtt(a, b) { return a.typ === b.typ && a.uri === b.uri && a.hoehe === b.hoehe && a.tag === b.tag && a.roh === b.roh; }
function verschmelze(ziel, quelle) {
  if (Buffer.compare(ziel.msg, quelle.msg) !== 0) throw new Error("OTS: Verschmelzen verschiedener Nachrichten");
  for (const a of quelle.att) if (!ziel.att.some((x) => gleicheAtt(x, a))) ziel.att.push(a);
  for (const o of quelle.ops) {
    const da = ziel.ops.find((x) => gleicheOp(x.op, o.op));
    if (da) verschmelze(da.kind, o.kind); else ziel.ops.push(o);
  }
  return ziel;
}

// ---- Datei -------------------------------------------------------------------------------
function datei(digest, knoten) { return Buffer.concat([MAGIE, varuint(1), Buffer.from([0x08]), digest, schreibeKnoten(knoten)]); }
function leseDatei(buf) {
  const r = leser(buf);
  if (Buffer.compare(r.bytes(MAGIE.length), MAGIE) !== 0) throw new Error("OTS: keine .ots-Datei");
  const v = r.varuint(); if (v !== 1) throw new Error("OTS: Version " + v);
  const op = r.byte(); if (op !== 0x08) throw new Error("OTS: nur sha256-Dateien");
  const digest = r.bytes(32);
  const k = leseKnoten(r, digest, 256);
  return { digest, knoten: k };
}

// Alle Bescheinigungen mit der Nachricht an ihrer Stelle.
function bescheinigungen(k, out) {
  out = out || [];
  for (const a of k.att) out.push(Object.assign({ msg: k.msg }, a));
  for (const o of k.ops) bescheinigungen(o.kind, out);
  return out;
}
function knotenMitPending(k, uri, out) {
  out = out || [];
  if (k.att.some((a) => a.typ === "pending" && a.uri === uri)) out.push(k);
  for (const o of k.ops) knotenMitPending(o.kind, uri, out);
  return out;
}

// ---- Netz: einreichen, aufwerten, Bitcoin prüfen -----------------------------------------
async function holeBytes(fetchFn, url, init, fristMs) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), fristMs || 15000) : null;
  try {
    const r = await fetchFn(url, Object.assign({}, init || {}, ctl ? { signal: ctl.signal } : {}));
    const b = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, body: b };
  } finally { if (t) clearTimeout(t); }
}
const KOPF = { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "manometer-referee/1" };

// Digest (32 Byte) bei mehreren Kalendern einreichen. Ergebnis: verschmolzener Knoten + je Kalender ok/Fehler.
async function einreichen(digest, opts) {
  const f = (opts && opts.fetch) || fetch, kal = (opts && opts.kalender) || KALENDER;
  const wurzel = { msg: digest, ops: [], att: [] }, stand = [];
  await Promise.all(kal.map(async (u) => {
    try {
      const r = await holeBytes(f, u + "/digest", { method: "POST", headers: Object.assign({ "Content-Type": "application/octet-stream" }, KOPF), body: digest }, (opts && opts.fristMs) || 15000);
      if (!r.ok) { stand.push({ kalender: u, ok: false, fehler: "HTTP " + r.status }); return; }
      verschmelze(wurzel, knotenAusAntwort(r.body, digest));
      stand.push({ kalender: u, ok: true });
    } catch (e) { stand.push({ kalender: u, ok: false, fehler: String((e && e.message) || e).slice(0, 120) }); }
  }));
  return { knoten: wurzel, stand, ok: stand.filter((s) => s.ok).length };
}
// Offene (pending) Bescheinigungen beim jeweiligen Kalender nachfragen; gefundene Bitcoin-Pfade einhängen.
async function aufwerten(knoten, opts) {
  const f = (opts && opts.fetch) || fetch;
  const offen = bescheinigungen(knoten).filter((a) => a.typ === "pending");
  let neu = 0; const stand = [];
  for (const a of offen) {
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(a.uri)) { stand.push({ uri: a.uri, ok: false, fehler: "URI abgelehnt" }); continue; }
    try {
      const r = await holeBytes(f, a.uri + "/timestamp/" + a.msg.toString("hex"), { headers: KOPF }, (opts && opts.fristMs) || 15000);
      if (r.status === 404) { stand.push({ uri: a.uri, ok: false, fehler: "noch nicht in Bitcoin" }); continue; }
      if (!r.ok) { stand.push({ uri: a.uri, ok: false, fehler: "HTTP " + r.status }); continue; }
      const teil = knotenAusAntwort(r.body, a.msg);
      for (const ziel of knotenMitPending(knoten, a.uri)) if (Buffer.compare(ziel.msg, a.msg) === 0) verschmelze(ziel, teil);
      neu++; stand.push({ uri: a.uri, ok: true });
    } catch (e) { stand.push({ uri: a.uri, ok: false, fehler: String((e && e.message) || e).slice(0, 120) }); }
  }
  return { neu, stand, bitcoin: bescheinigungen(knoten).filter((a) => a.typ === "bitcoin").length };
}
// Bitcoin-Bescheinigung gegen einen öffentlichen Block-Explorer (Esplora-API, z. B. blockstream.info) prüfen:
// die Nachricht an der Bescheinigung ist die Merkle-Wurzel des Blocks (interne Byte-Reihenfolge).
async function pruefeBitcoin(att, opts) {
  const f = (opts && opts.fetch) || fetch, basis = (opts && opts.esplora) || "https://blockstream.info/api";
  const h = await holeBytes(f, basis + "/block-height/" + att.hoehe, {}, 15000);
  if (!h.ok) return { ok: false, fehler: "Blockhöhe " + att.hoehe + ": HTTP " + h.status };
  const hash = h.body.toString("utf8").trim();
  const b = await holeBytes(f, basis + "/block/" + hash, {}, 15000);
  if (!b.ok) return { ok: false, fehler: "Block " + hash + ": HTTP " + b.status };
  const j = JSON.parse(b.body.toString("utf8"));
  const erwartet = Buffer.from(att.msg).reverse().toString("hex");
  return { ok: j.merkle_root === erwartet, hoehe: att.hoehe, block: hash, zeit: j.timestamp ? j.timestamp * 1000 : null, fehler: j.merkle_root === erwartet ? null : "Merkle-Wurzel passt nicht" };
}

module.exports = { MAGIE, KALENDER, TAG_PENDING, TAG_BITCOIN, leser, varuint, varbytes, wendeAn, leseKnoten, schreibeKnoten, knotenAusAntwort,
  verschmelze, datei, leseDatei, bescheinigungen, einreichen, aufwerten, pruefeBitcoin };
