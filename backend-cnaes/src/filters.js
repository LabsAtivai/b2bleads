// src/filters.js
export function parseLocalizacao(input) {
  if (!input) return {};
  const s = (input || "").trim();

  if (/^\d{8}$/.test(s)) {
    // CEP (apenas dígitos)
    return { cep: s };
  }

  if (/^[A-Za-z]{2}$/.test(s)) {
    // UF
    return { uf: s.toUpperCase() };
  }

  if (/^\d{4}$/.test(s)) {
    // código município
    return { municipio_codigo: s };
  }

  // cidade prefixo
  return { cidade: { $regex: `^${s}`, $options: "i" } };
}

// 🔹 PRINCIPAL AJUSTE: usar capitalSocial (camelCase) em vez de capital_social
export function parseCapitalSocial(expr) {
  if (!expr) return {};
  const s = expr.replace(/\s/g, "");

  const field = "capitalSocial";

  // intervalo: 10000-50000
  if (/^\d+-\d+$/.test(s)) {
    const [a, b] = s.split("-").map(Number);
    return { [field]: { $gte: a, $lte: b } };
  }

  // comparações: >10000, >=10000, <50000, <=50000
  if (/^[<>]=?\d+$/.test(s)) {
    const op = s.match(/^[<>]=?/)[0];
    const num = Number(s.replace(/^[<>]=?/, ""));

    if (op === ">") return { [field]: { $gt: num } };
    if (op === ">=") return { [field]: { $gte: num } };
    if (op === "<") return { [field]: { $lt: num } };
    if (op === "<=") return { [field]: { $lte: num } };
  }

  return {};
}
