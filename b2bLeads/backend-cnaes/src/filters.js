export function parseLocalizacao(input) {
  if (!input) return { clause: null, params: [] }
  const s = (input || '').trim()
  if (/^\d{8}$/.test(s)) {           // CEP
    return { clause: 'cep = ?', params: [s] }
  }
  if (/^[A-Za-z]{2}$/.test(s)) {     // UF
    return { clause: 'uf = UPPER(?)', params: [s] }
  }
  if (/^\d{4}$/.test(s)) {           // código de município
    return { clause: 'municipio_codigo = ?', params: [s] }
  }
  // cidade (prefixo)
  return { clause: 'cidade LIKE ?', params: [`${s}%`] }
}

export function parseCapitalSocial(expr) {
  if (!expr) return { clause: null, params: [] }
  const s = expr.replace(/\s/g, '')
  if (/^\d+-\d+$/.test(s)) {
    const [a,b] = s.split('-').map(Number)
    return { clause: 'capital_social BETWEEN ? AND ?', params: [a,b] }
  }
  if (/^[<>]=?\d+$/.test(s)) {
    const op = s.match(/^[<>]=?/)[0]
    const num = Number(s.replace(/^[<>]=?/, ''))
    return { clause: `capital_social ${op} ?`, params: [num] }
  }
  return { clause: null, params: [] }
}
