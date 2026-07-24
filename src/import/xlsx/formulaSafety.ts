/** Return false for formulas that can initiate external network, DDE, or RTD activity. */
export function isSafeSpreadsheetFormula(formula: string): boolean {
  const normalized = formula.replace(/^=/, '').replace(/\s+/g, '').toUpperCase()
  if (!normalized || normalized.length > 8192) return false
  if (/\b(?:WEBSERVICE|FILTERXML|RTD|HYPERLINK|IMAGE|DISPIMG|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTRANGE)\s*\(/.test(normalized)) return false
  // Excel external workbook / DDE spellings: [book.xlsx]Sheet!A1 and app|topic!item.
  if (/\[[^\]]+\][^!]*!/.test(normalized) || /(?:^|[=,+\-*/(])[^'"]+\|[^!]+!/.test(normalized)) return false
  return true
}
