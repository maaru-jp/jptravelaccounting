/** 一個月中部北陸範例行程：依日期自動對應消費地區 */
export function buildDefaultItinerary(startStr, days = 30) {
  const regions = [
    "名古屋",
    "名古屋",
    "高山",
    "高山",
    "金澤",
    "金澤",
    "金澤",
    "能登・加賀",
    "能登・加賀",
    "富山",
    "立山黑部",
    "立山黑部",
    "松本",
    "松本",
    "上高地",
    "上高地",
    "諏訪",
    "富士山麓",
    "富士山麓",
    "東京",
    "東京",
    "東京",
    "鎌倉・橫濱",
    "鎌倉・橫濱",
    "輕井澤",
    "輕井澤",
    "長野",
    "名古屋",
    "名古屋",
    "中部國際機場",
  ];
  const start = new Date(startStr + "T12:00:00");
  const map = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    map[key] = regions[i] ?? "日本";
  }
  return map;
}

export function regionForDate(itinerary, dateStr) {
  if (itinerary && itinerary[dateStr]) return itinerary[dateStr];
  return "";
}
