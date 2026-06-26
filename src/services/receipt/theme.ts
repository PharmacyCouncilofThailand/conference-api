import { Font } from "@react-pdf/renderer";
import { existsSync } from "fs";
import path from "path";

// Register the Thai receipt font. We prefer THSarabunNew so the output matches
// the official template 1:1 (THSarabunNew renders noticeably larger than Sarabun
// at the same point size). We fall back to Sarabun, then to the built-in
// Helvetica, so rendering never crashes even if no Thai font is bundled
// (Latin content still renders; Thai glyphs would be missing in that case).
const thDir = path.join(process.cwd(), "public", "Font", "thsarabun");
const thRegular = path.join(thDir, "THSarabunNew.ttf");
const thBold = path.join(thDir, "THSarabunNew Bold.ttf");

const saDir = path.join(process.cwd(), "public", "Font", "sarabun");
const saRegular = path.join(saDir, "Sarabun-Regular.ttf");
const saBold = path.join(saDir, "Sarabun-Bold.ttf");

let mainFont = "Helvetica";

if (existsSync(thRegular) && existsSync(thBold)) {
  Font.register({
    family: "ReceiptThai",
    fonts: [
      { src: thRegular, fontWeight: "normal" },
      { src: thBold, fontWeight: "bold" },
    ],
  });
  mainFont = "ReceiptThai";
} else if (existsSync(saRegular) && existsSync(saBold)) {
  Font.register({
    family: "ReceiptThai",
    fonts: [
      { src: saRegular, fontWeight: "normal" },
      { src: saBold, fontWeight: "bold" },
    ],
  });
  mainFont = "ReceiptThai";
}

// Disable hyphenation so Thai/Latin words are not broken with hyphens.
Font.registerHyphenationCallback((word) => [word]);

export const colors = {
  primary: "#000000",
  secondary: "#000000",
  accent: "#000000",
  border: "#000000",
  lightBorder: "#cccccc",
  gray: "#f5f5f5",
  white: "#ffffff",
};

export const theme = {
  colors,
  fonts: {
    main: mainFont,
  },
  fontSizes: {
    body: 14,
    h1: 20,
    h2: 18,
    h3: 16,
  },
  spacing: {
    padding: 40,
  },
};

/**
 * Format a money amount with thousands separators and 2 decimal places.
 */
export function fmtMoney(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
