import { CATEGORIES, PAYMENTS } from "./config.js";

function pick(arr, i) {
  return arr[i % arr.length];
}

/** 產生示範資料（約一個月、多人、多類別） */
export function generateSeedTransactions(startStr, count = 48) {
  const places = [
    { loc: "Lawson", cat: "dining", desc: "咖啡、麵包" },
    { loc: "金澤駅", cat: "transport", desc: "北陸新幹線指定席" },
    { loc: "加賀屋", cat: "hotel", desc: "温泉宿泊" },
    { loc: "近江町市場", cat: "dining", desc: "海鮮丼、炙燒壽司" },
    { loc: "無印良品", cat: "shopping", desc: "旅行小物、文具" },
    { loc: "7-Eleven", cat: "dining", desc: "御飯糰、飲料" },
    { loc: "FamilyMart", cat: "dining", desc: "宵夜、啤酒" },
    { loc: "高山老街", cat: "sight", desc: "飛驒牛串、味噌" },
    { loc: "白川鄉", cat: "sight", desc: "合掌村入場、紀念品" },
    { loc: "立山纜車", cat: "transport", desc: "Alpine Route 票券" },
    { loc: "松本城", cat: "sight", desc: "城門票、導覽" },
    { loc: "上高地バス", cat: "transport", desc: "往返巴士" },
    { loc: "富士急樂園", cat: "sight", desc: "一日券" },
    { loc: "伊東屋", cat: "shopping", desc: "手帳、紙品" },
    { loc: "藥妝店", cat: "shopping", desc: "面膜、藥品" },
    { loc: "居酒屋", cat: "dining", desc: "串燒、生啤" },
    { loc: "星巴克", cat: "dining", desc: "季節限定" },
    { loc: "迴轉壽司", cat: "dining", desc: "晚餐" },
    { loc: "計程車", cat: "transport", desc: "深夜移動" },
    { loc: "便利商店 ATM", cat: "other", desc: "提領手續費" },
  ];
  const payRotate = ["cash", "paypay", "suica", "card"];
  const travelers = ["t1", "t2"];
  const start = new Date(startStr + "T12:00:00");
  const list = [];
  for (let i = 0; i < count; i++) {
    const dayOff = Math.floor(i / 1.6) % 30;
    const d = new Date(start);
    d.setDate(d.getDate() + dayOff);
    const date = d.toISOString().slice(0, 10);
    const p = pick(places, i);
    const base = 280 + (i * 137) % 4200;
    const taxNote = i % 3 === 0 ? "內稅" : i % 3 === 1 ? "外稅10%" : "免稅";
    list.push({
      id: `seed-${i}-${Date.now()}`,
      date,
      amountJpy: base,
      category: p.cat,
      payment: payRotate[i % payRotate.length],
      location: p.loc,
      region: "",
      description: p.desc,
      travelerId: travelers[i % 2],
      items: [
        {
          nameJa: "商品A",
          nameZh: p.desc,
          price: base,
          tax: taxNote,
        },
      ],
      createdAt: new Date().toISOString(),
    });
  }
  return list;
}

export const DEFAULT_TRAVELERS = [
  { id: "t1", name: "小薇", emoji: "👩" },
  { id: "t2", name: "阿瑋", emoji: "👨" },
];
