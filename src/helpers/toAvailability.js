export const toAvailability = (v) => {
  if (!v) return null;
  const s = String(v);
  if (/out\s*of\s*stock|outofstock|soldout|discontinued/i.test(s))
    return "out_of_stock";
  if (/pre-?order/i.test(s)) return "pre_order";
  if (/in\s*stock|instock|limitedavailability/i.test(s)) return "in_stock";
  return null;
};
