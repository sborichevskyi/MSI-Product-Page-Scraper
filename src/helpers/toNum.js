export const toNum = (v) => {
  if (v == null) return null;
  const m = String(v)
    .replace(/,/g, "")
    .match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};
