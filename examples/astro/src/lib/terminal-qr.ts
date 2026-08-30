/**
 * QR codes in the terminal, the way `expo start` does it.
 *
 * The tunnel URL is only known once the tunnel is up, and getting it onto a
 * phone otherwise means retyping a random subdomain or emailing yourself a
 * link. Printing it as a scannable code removes that step entirely.
 */

import { encodeQR } from "etiket/qr";

/** Terminal cells are about twice as tall as they are wide. */
const UPPER_HALF = `▀`;
const FULL = `█`;
const BLANK = ` `;

const RESET = `[0m`;
/** Black on white. QR scanners want dark modules on a light ground. */
const INK = `[30;47m`;

/**
 * Render a QR as text.
 *
 * Uses half-block characters so each printed row covers TWO matrix rows: a
 * terminal cell is roughly 1:2, so one character per module produces a symbol
 * stretched vertically that many scanners refuse. Encoding the upper module as
 * foreground and the lower as background makes it square and halves the height.
 *
 * @param quiet Modules of quiet zone. The spec minimum is 4 and it is part of
 *   the symbol — without it a scanner cannot find the finder patterns against
 *   surrounding terminal text.
 */
export const qrToTerminal = (
  data: string,
  { quiet = 2 }: { quiet?: number } = {}
): string => {
  const matrix = encodeQR(data);
  const size = matrix.length;

  // Padded into a new matrix rather than printed around, so the half-block
  // pairing below does not have to special-case the edges.
  const padded = size + quiet * 2;
  const at = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    if (r < 0 || c < 0 || r >= size || c >= size) return false;
    return matrix[r]?.[c] ?? false;
  };

  const lines: string[] = [];
  // Two matrix rows per printed row.
  for (let row = 0; row < padded; row += 2) {
    let line = ``;
    for (let col = 0; col < padded; col++) {
      const top = at(row, col);
      const bottom = at(row + 1, col);
      // Foreground paints the top half, background the bottom, so the two
      // booleans pick one of four glyphs.
      if (top && bottom) line += FULL;
      else if (top) line += UPPER_HALF;
      else if (bottom) line += `▄`;
      else line += BLANK;
    }
    lines.push(`${INK}${line}${RESET}`);
  }

  return lines.join(`\n`);
};
