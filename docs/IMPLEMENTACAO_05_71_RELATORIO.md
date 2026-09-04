# SPRINT 05.71

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — `espelharTributosNfeDevolucaoCompra.js` (lookup Central) e `nfeDevolucaoCompra.js` (passa `compra.empresa_id`)

FUNÇÃO: `espelharTributosNfeDevolucaoCompra` / `carregarXmlNfeCompraOrigem`

LOOKUP ANTERIOR: `REPLACE(chave) = ? LIMIT 1`

LOOKUP NOVO: `REPLACE(chave) = ? AND empresa_id = ? LIMIT 1` (também `compra_id` + `empresa_id`)

FONTE empresa_id: `compra.empresa_id` persistido (SELECT c.*). Sem empresa: EMPRESA_OWNERSHIP_REQUIRED, sem lookup global.

CROSS-COMPANY: B + X não devolve nem altera o documento A

NULL: não é tratado como documento de A/B; sem COALESCE

TESTES: 10/10 (`tests/central-entradas/isolamento-xml-devolucao-empresa-05-71.test.js`)

REGRESSÕES (2026-08-29): ALL_OK — 05.71 10/10 · 05.70 12/12 · 05.69 8/8 · 05.68–05.54 verdes (05.54 12/12)

RISCOS RESTANTES:
- XML legado DistDFe/disco ainda por chave
- GET `/buscar-chave` sem empresa no contexto (05.70.2)
- compra `empresa_id` NULL bloqueia espelhamento Central
