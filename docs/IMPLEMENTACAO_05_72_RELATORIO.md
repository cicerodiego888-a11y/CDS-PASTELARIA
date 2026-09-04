# SPRINT 05.72

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — `GET /buscar-chave`, cadeia `buscarPorChave(chave, opcoes)` até o sync, `centralEntradasFetch` (header)

ENDPOINT: GET /buscar-chave

LOOKUP: buscarPorChave(chave, empresaId)

FONTE empresa_id: `resolverEmpresaParaCentral` (header/`req.empresaId` em MULTIEMPRESA; empresa operacional do contrato em EMPRESA_SIMPLES)

MULTIEMPRESA: X-Empresa-Id obrigatório; sem empresa → EMPRESA_CENTRAL_AUSENTE, sem SELECT por chave e sem consChNFe

EMPRESA_SIMPLES: empresa operacional do contrato (sem nova regra)

CROSS-COMPANY: caller B + chave X não devolve documento A (`documento: null`; sem id/fornecedor/XML/empresa da outra)

NULL: não atribuído a A/B; sem COALESCE

TESTES: 10/10 (`tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js`)

REGRESSÕES (2026-08-29): ALL_OK — 05.72 10/10 · 05.71 10/10 · 05.70 12/12 · 05.69 8/8 · 05.68 · 05.67 · 05.66 · 05.65 · 05.64 · 05.63 · 05.62 · 05.61 · 05.60 · 05.59 · 05.58 · 05.57 · 05.56 · 05.55 16/16 · 05.54 12/12

RISCOS RESTANTES:
- lookup legado DistDFe/disco por chave
- UNIQUE + vários NULL no SQLite
- resposta SEFAZ da chave (não é o documento da Central)
