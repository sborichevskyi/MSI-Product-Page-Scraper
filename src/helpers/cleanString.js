export const cleanString = (v) => {
  const s = (v ?? "").toString().replace(/\s+/g, " ").trim();
  return s || null;
};
