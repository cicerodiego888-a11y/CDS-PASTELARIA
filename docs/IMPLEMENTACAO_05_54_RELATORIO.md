# SPRINT 05.54

## OBJETIVO

Ativar **explicitamente** `modo_operacional_global = MULTIEMPRESA` pela configuração oficial, para a Central de Entradas listar as 3 empresas ativas como alvos. Sem fallback e sem motor paralelo.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `frontend/erp/js/cds-centro-configuracoes.js` | Textos EMPRESA_SIMPLES / MULTIEMPRESA; não auto-preenche empresa operacional |

## ARQUIVOS CRIADOS

| Arquivo | Papel |
|---------|--------|
| `tests/central-entradas/modo-multiempresa-05-54.test.js` | T01–T10 + T11 sync + T12 UI/endpoint |
| `docs/arquitetura/MODO_MULTIEMPRESA_CENTRAL_05_54.md` | contrato |
| este relatório | |

Não alterados: DistDFe, MIIP, compras, NF-e/NFC-e, `ContratoOperacionalService`, `listarAlvosSincronizacaoCentral`, `POST /api/configuracoes-avancadas`.

## COMO ERA

A instalação em EMPRESA_SIMPLES com 3 empresas ativas e sem `empresa_operacional_id` válido gerava `EMPRESA_OPERACIONAL_AMBIGUA` na Central. O modo já era configuração explícita; a UI existia no Centro de Configurações.

## COMO FICOU

Mesmo pipeline (saveConfig → validador → contrato → alvos). Copy da UI alinhado à sprint. Testes cobrem 3 empresas, preservação de `empresa_operacional_id` ao salvar MULTIEMPRESA, e sync em que certificado de B falha sem contaminar NSU de A/C.

**Ativação no cliente:** SUPER_ADMIN em Configurações Avançadas → Multiempresa → confirmar ao salvar. Não há troca automática por `empresas.length`.

## TESTES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| `modo-multiempresa-05-54` | 12/12 OK |
| `modo-operacional-global-05-38-b` | 17/17 OK |
| `central-entradas-multiempresa-05-38-e` | 19/19 OK |

SEFAZ real não foi chamado (certificado/homologação fora do escopo). T11 exercita `sincronizar()` com 3 alvos e isolamento de NSU/erro.

## INVARIANTE

```
modo_operacional_global explícito
  MULTIEMPRESA → contrato.empresa_operacional = null
               → listarAlvosSincronizacaoCentral = empresas ativas
  EMPRESA_SIMPLES + N>1 sem id → EMPRESA_OPERACIONAL_AMBIGUA
```
