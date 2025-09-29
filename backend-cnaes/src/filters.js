// src/filters.js
export function parseLocalizacao(input) {
  if (!input) return {}
  const s = (input || '').trim()

  if (/^\d{8}$/.test(s)) { // CEP
    return { cep: s }
  }

  if (/^[A-Za-z]{2}$/.test(s)) { // UF
    return { uf: s.toUpperCase() }
  }

  if (/^\d{4}$/.test(s)) { // código município
    return { municipio_codigo: s }
  }

  // cidade prefixo
  return { cidade: { $regex: `^${s}`, $options: 'i' } }
}

export function parseCapitalSocial(expr) {
  if (!expr) return {}
  const s = expr.replace(/\s/g, '')

  if (/^\d+-\d+$/.test(s)) {
    const [a, b] = s.split('-').map(Number)
    return { capital_social: { $gte: a, $lte: b } }
  }

  if (/^[<>]=?\d+$/.test(s)) {
    const op = s.match(/^[<>]=?/)[0]
    const num = Number(s.replace(/^[<>]=?/, ''))

    if (op === '>') return { capital_social: { $gt: num } }
    if (op === '>=') return { capital_social: { $gte: num } }
    if (op === '<') return { capital_social: { $lt: num } }
    if (op === '<=') return { capital_social: { $lte: num } }
  }

  return {}
}
