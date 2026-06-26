const UNITS = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const POSITIONS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน"];

function convertInteger(num: number): string {
  if (num === 0) return "ศูนย์";

  let result = "";
  const numStr = Math.floor(num).toString();
  const len = numStr.length;

  for (let i = 0; i < len; i++) {
    const digit = parseInt(numStr[i], 10);
    const pos = len - i - 1;

    if (digit !== 0) {
      if (pos === 1 && digit === 1) {
        result += "สิบ";
      } else if (pos === 1 && digit === 2) {
        result += "ยี่สิบ";
      } else if (pos === 0 && digit === 1 && len > 1) {
        result += "เอ็ด";
      } else {
        result += UNITS[digit] + POSITIONS[pos];
      }
    }
  }

  return result;
}

/**
 * Convert a number to Thai baht text, e.g.
 *  1500      -> "หนึ่งพันห้าร้อยบาทถ้วน"
 *  1500.50   -> "หนึ่งพันห้าร้อยบาทห้าสิบสตางค์"
 */
export function numberToThaiText(num: number): string {
  const baht = Math.floor(num);
  const satang = Math.round((num - baht) * 100);

  let text = "";

  if (baht > 0) {
    text += convertInteger(baht) + "บาท";
  } else if (satang === 0) {
    text += "ศูนย์บาท";
  }

  if (satang > 0) {
    text += convertInteger(satang) + "สตางค์";
  } else {
    text += "ถ้วน";
  }

  return text;
}
