/**
 * What the digits of a GTIN mean.
 *
 * A scanned barcode is a number, and a number on its own tells someone
 * squinting at a debug screen very little. The leading digits are allocated by
 * GS1 in blocks, so a few of them can be named — which is enough to tell a
 * book from a bottle from a supermarket's own weighed produce.
 *
 * This is presentation, not identification. Nothing here changes what was
 * decoded, and a caller looking a product up should use the digits.
 */

/** What a prefix says about a code. */
export interface GtinPrefix {
  /** A short label, for showing beside the number. */
  readonly label: string;
  /**
   * Longer context, where the short label would mislead on its own.
   *
   * Present on exactly the entries where the obvious reading is wrong.
   */
  readonly note?: string;
}

/**
 * Named blocks, longest match first.
 *
 * Deliberately partial. The full GS1 list is every member organisation on
 * earth and changes without notice; naming all of it would be a maintenance
 * burden for a debug screen, and a stale list is worse than an honest "not
 * recognised". These are the blocks that mean something structurally
 * different — books, periodicals, coupons, in-store codes — plus a handful of
 * the most common issuing regions.
 */
const BLOCKS: ReadonlyArray<readonly [string, GtinPrefix]> = [
  // Structural blocks: these are not products in the ordinary sense.
  [
    `978`,
    {
      label: `Book (ISBN)`,
      note: `An ISBN carried in an EAN-13. The ISBN is this code without its first three digits and with its own check digit.`
    }
  ],
  [
    `979`,
    {
      label: `Book or sheet music`,
      note: `ISBN, or ISMN when the fourth digit is 0.`
    }
  ],
  [
    `977`,
    {
      label: `Periodical (ISSN)`,
      note: `A magazine or journal. The two digits before the check digit are usually an issue number, so consecutive issues differ.`
    }
  ],
  [`99`, { label: `Coupon`, note: `Not a product — a redeemable coupon.` }],
  [`98`, { label: `Coupon`, note: `Not a product — a redeemable coupon.` }],

  // In-store codes, which exist only inside one retailer.
  [
    `02`,
    {
      label: `In-store (variable weight)`,
      note: `Assigned by the shop, usually for something weighed at the counter. Part of the number is the price or weight, so it will not match any product database.`
    }
  ],
  [
    `2`,
    {
      label: `In-store`,
      note: `Assigned by the shop for its own use. Meaningful only in that shop, and not in any product database.`
    }
  ],

  // Issuing organisations. A few of the most commonly encountered.
  [`45`, { label: `GS1 Japan` }],
  [`49`, { label: `GS1 Japan` }],
  [`0`, { label: `GS1 US / Canada` }],
  [`1`, { label: `GS1 US` }],
  [`30`, { label: `GS1 France` }],
  [`31`, { label: `GS1 France` }],
  [`32`, { label: `GS1 France` }],
  [`33`, { label: `GS1 France` }],
  [`34`, { label: `GS1 France` }],
  [`35`, { label: `GS1 France` }],
  [`36`, { label: `GS1 France` }],
  [`37`, { label: `GS1 France` }],
  [`40`, { label: `GS1 Germany` }],
  [`41`, { label: `GS1 Germany` }],
  [`42`, { label: `GS1 Germany` }],
  [`43`, { label: `GS1 Germany` }],
  [`44`, { label: `GS1 Germany` }],
  [`46`, { label: `GS1 Russia` }],
  [`47`, { label: `GS1 Taiwan` }],
  [`50`, { label: `GS1 UK` }],
  [`54`, { label: `GS1 Belgium / Luxembourg` }],
  [`57`, { label: `GS1 Denmark` }],
  [`64`, { label: `GS1 Finland` }],
  [`69`, { label: `GS1 China` }],
  [`70`, { label: `GS1 Norway` }],
  [`73`, { label: `GS1 Sweden` }],
  [`76`, { label: `GS1 Switzerland` }],
  [`80`, { label: `GS1 Italy` }],
  [`81`, { label: `GS1 Italy` }],
  [`82`, { label: `GS1 Italy` }],
  [`83`, { label: `GS1 Italy` }],
  [`84`, { label: `GS1 Spain` }],
  [`87`, { label: `GS1 Netherlands` }],
  [`88`, { label: `GS1 South Korea` }],
  [`89`, { label: `GS1 India` }],
  [`93`, { label: `GS1 Australia` }],
  [`94`, { label: `GS1 New Zealand` }]
];

/**
 * Describe a scanned GTIN, if anything is known about its prefix.
 *
 * A UPC-A is padded back to thirteen digits before matching, because that is
 * the space the prefixes are allocated in — a twelve-digit UPC beginning `0`
 * is a thirteen-digit GTIN beginning `00`, and matching the printed form would
 * put every US product in the wrong block.
 *
 * A GS1 prefix names the organisation a company registered with, **not** where
 * anything was made: a company may license a prefix in one country and
 * manufacture in another. The labels say "GS1 Japan" rather than "Japan" for
 * that reason, and nothing here should be presented as origin.
 */
export const describeGtin = (value: string): GtinPrefix | null => {
  if (!/^\d+$/u.test(value)) return null;

  // EAN-8 has no room for these blocks: eight digits are a compressed
  // allocation, not a prefix plus a company code.
  if (value.length === 8) return null;

  const padded = value.length === 12 ? `0${value}` : value;

  // Longest first, so `02` wins over `0` and `978` over a shorter block.
  const sorted = [...BLOCKS].sort(
    ([first], [second]) => second.length - first.length
  );

  for (const [prefix, description] of sorted) {
    if (padded.startsWith(prefix)) return description;
  }

  return null;
};
