# manometer-verify

Check a Manometer scorecard bundle without trusting Manometer's servers.

A scorecard bundle (`https://manometer.bet/s/<source>/bundle.json`) contains everything the referee used: the signed
receipts, the time-locked ciphertexts, the opened proposals with their drand beacons, the market row at receipt with its
Merkle path, the closing line and the final score with their paths to the hourly anchors, the anchors' OpenTimestamps
proofs, the referee's public key and the scoring rules. This program recomputes all of it.

```bash
npm install                                  # tlock-js 0.9.0 (drand), nothing else
node manometer-verify.js all src_you.bundle.json
```

| Command    | What it checks |
|------------|----------------|
| `receipts` | Ed25519 signature of every receipt (referee key in the bundle; compare it with `/netz/pubkey`), the receipt id, the SHA-256 fingerprint of the ciphertext or proposal, the Merkle path to its hourly anchor, the anchor's `.ots` proof and — online — the Bitcoin block header from a public explorer (`--esplora`, default blockstream.info). |
| `seals`    | Each ciphertext names its drand quicknet round; it opens with that round's beacon (online: fetched from drand, not from us) to exactly the published proposal; it was not already open when received; a seal opening before kick-off is marked as such. |
| `prices`   | The market row at receipt belongs to the snapshot whose root is in the signed receipt; fair price and best network-book price are recomputed from that row; the closing line belongs to the same game and is anchored; CLV per proposal and the scorecard average are recomputed. |
| `results`  | Each result is anchored and belongs to the same Pinnacle event; WIN/LOSS/PUSH/half results are recomputed from the full-time score; paper profit and yield are recomputed. |
| `all`      | All of the above plus the bundle root (Merkle root over all entries — nothing can be removed or added unnoticed). |

Market rows, fair prices and best prices are released at kick-off. A bundle downloaded earlier shows only whether a proposal was executable; download it again after kick-off to check its prices.

`--offline` skips the independent network lookups (drand, Bitcoin) and relies on the data in the bundle.
Exit code 0 = everything checked out, 1 = at least one mismatch, 2 = unreadable input.

## Formats

* Canonical JSON: object keys sorted, no whitespace, `undefined` dropped.
* Merkle trees: RFC 6962 (leaf = SHA-256(0x00 ‖ data), node = SHA-256(0x01 ‖ left ‖ right)).
* Time lock: tlock (age format, one `tlock <round> <chain>` recipient) to drand quicknet
  `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`.
* Anchors: standard OpenTimestamps `.ots` files (also checkable with the official `ots verify`).

`lib/` is a byte-identical copy of the referee's own modules, so this program computes exactly what the referee computes.

## Licence

Apache-2.0. The Manometer name and logo are not covered by the licence.
