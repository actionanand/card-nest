# Dashboard "Breakdown" popup

The dashboard hero shows three figures — **Total outstanding**, **Statement dues** and
**Unbilled**. Tapping any of them opens the **Breakdown** popup, which itemises exactly how that
figure is made up, per card, so it always reconciles with the number on the homepage.

## The three views

| Tile                  | What it lists                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Total outstanding** | Everything you currently owe: the balance carried into the latest statement plus every transaction since.                                                                   |
| **Statement dues**    | Only the latest **generated** statement of each card — that billing cycle's transactions plus any balance carried forward, minus payments/refunds made after the statement. |
| **Unbilled**          | Purchases made **after** the latest statement that will appear on the next bill.                                                                                            |

### Statement anchors

For each card two dates are derived from its statement day:

- **S** – the latest statement date that has already been generated.
- **P** – the statement date before it.

From those:

- **Previous balance** = everything billed on or before **P** (opening balance + effects). It is
  shown as a single "Previous balance — carried into this statement" row rather than re-listing old
  transactions.
- **Statement dues** = Previous balance + transactions in the cycle `(P, S]` + payments/refunds
  made after **S**.
- **Unbilled** = charges dated after **S**.
- **Total outstanding** = Previous balance + all activity after **P** (statement cycle + unbilled).

### How rows are signed

- **Spends / charges** increase what you owe and are shown as `−` (e.g. `−₹1,422.98`).
- **Payments, refunds, cashbacks and credits** reduce what you owe and are shown as `+` in green.
- The **Previous balance** row is not an individual transaction; it is a rolled-up carry-forward.

Each card's subtotal (the coloured pill) equals `Previous balance + Σ(rows)`, and the popup total
equals `Σ(card subtotals)`, which matches the homepage figure exactly.

### EMI and recurring badges

Rows that belong to a plan carry a small badge:

- **EMI** → `installment / tenure`, e.g. `2/3`.
- **Recurring** → `occurrence / limit`, e.g. `21/∞` when the rule has no end.

## "Ignore paid dues"

Checked by default. When on, any card whose subtotal is `₹0.00` (fully paid this cycle) is hidden.
Turn it off to also see fully-settled cards with their offsetting payments.

## "Highlight big spends" and the colouring rules

A toggle (checked by default) is available both in the Breakdown popup and in
**Settings → Preferences**. When it is off, no rows are highlighted. When it is on, the biggest
spends are tinted so the highest amounts are easy to spot.

Only **spends** are ever considered. Payments, refunds, cashbacks/credits and the Previous balance
row are always excluded from the calculation and never highlighted.

### The threshold

**Settings → Minimum amount to highlight transactions** (default **₹4,000**) sets the amount above
which spends qualify for highlighting. The field is disabled while "Highlight big spends" is off.

### How a colour is chosen

The calculation is recomputed for each popup, using `max` = the largest single spend currently
shown.

1. **If any spend reaches the threshold** (`max ≥ threshold`):
   - Spends **below** the threshold are not highlighted.
   - For the qualifying spends, the range `[threshold … max]` is split at its midpoint
     `mid = (threshold + max) / 2`:
     - spend `≥ mid` → **high** (light red)
     - `threshold ≤` spend `< mid` → **mid** (light amber)
2. **If every spend is below the threshold**, the popup falls back to a relative scale of the
   largest spend so the top items are still highlighted:
   - `spend / max ≥ 0.66` → **high** (light red)
   - `spend / max ≥ 0.33` → **mid** (light amber)
   - otherwise → not highlighted

In short: high-value spends get a light-red tint, mid-value spends a lighter amber tint, and the
grading is unique to whatever is on screen in that popup.
