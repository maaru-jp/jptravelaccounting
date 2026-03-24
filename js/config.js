export const CATEGORIES = [
  { id: "dining", label: "餐飲", className: "tag-cat--dining" },
  { id: "shopping", label: "購物", className: "tag-cat--shopping" },
  { id: "transport", label: "交通", className: "tag-cat--transport" },
  { id: "hotel", label: "住宿", className: "tag-cat--hotel" },
  { id: "sight", label: "景點", className: "tag-cat--sight" },
  { id: "other", label: "其他", className: "tag-cat--other" },
];

export const PAYMENTS = [
  { id: "cash", label: "現金" },
  { id: "paypay", label: "PayPay" },
  { id: "suica", label: "Suica / IC" },
  { id: "card", label: "信用卡" },
];

export function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}

export function paymentById(id) {
  return PAYMENTS.find((p) => p.id === id) || PAYMENTS[0];
}
