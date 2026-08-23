# Implementação 05.02 — Contexto operacional e seleção de empresa

**Status:** concluída · **Sem tela de PDV** · **Sem checkout**

## Contexto operacional ≠ empresa do item

| Conceito | Autoridade |
|---|---|
| `empresa_selecionada` | Sessão do PDV Universal (`X-Empresa-Id`) |
| `empresaId` do item MUV | Obrigatório no item; **nunca** herdado do contexto |

Produto é global. Estoque é da empresa. `produtoId ≠ empresaId`.

## EMPRESA_UNICA

- Checkout futuro exige empresa operacional.
- 0 empresas + operador → `NENHUMA_EMPRESA_DISPONIVEL`.
- 1 empresa ativa disponível → resolução automática (`UNICA_DISPONIVEL`).
- 2+ empresas → `empresa_selecionada = null`, `exige_selecao: true`.
- Nunca assume empresa 1.

## MULTIEMPRESA

- Pode iniciar com `empresa_selecionada = null`.
- Seleção é preferência/filtro/visual.
- Itens A/B/C continuam com `empresaId` explícito no MUV.

## Persistência

Mecanismo oficial já existente: header `X-Empresa-Id` + `localStorage` no cliente (`cds-empresa-contexto.js`). Sem claim no JWT. Sem gravar em venda, estoque, atendimento ou fiscal.

`PUT /api/pdv-universal/contexto/empresa` apenas **valida** via `EmpresaService.selecionarEmpresaContexto` e devolve o contexto. O cliente continua enviando `X-Empresa-Id`.

## HTTP

- `GET /api/pdv-universal/contexto` — contexto completo (modo, operador, empresa, lista, capabilities).
- `PUT /api/pdv-universal/contexto/empresa` `{ empresa_id }` — autenticação `verificarToken`.

## Capabilities (backend)

EMPRESA_UNICA: `exige_empresa_unica_para_checkout: true`, `empresa_por_item: false`.  
MULTIEMPRESA: `permite_multiplas_empresas_no_atendimento: true`, `empresa_por_item: true`.
