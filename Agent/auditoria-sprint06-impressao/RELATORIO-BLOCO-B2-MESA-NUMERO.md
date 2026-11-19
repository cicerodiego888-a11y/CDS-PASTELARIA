# RELATÓRIO — B2 correção `mesa_numero`

**Status:** ENTREGUE — aguardando nova auditoria  
**Bloco C:** NÃO INICIADO  
**Schema:** v3 inalterado  

## Correção

| Arquivo | Mudança |
|---|---|
| `CozinhaDespachoService.js` | `mesa_numero: String(mesa.numero)` (já carregado/validado na TX) |
| `CozinhaImpressaoFilaService.js` | Fallback de `enfileirarDaRodada` resolve `mesas.numero` — nunca `rodada.mesa_id` |
| `sprint06-bloco-b2-idempotencia-despacho.test.js` | Teste **14**: id≠numero → snapshot com `mesa_numero=5` |

## Resultados

| Suite | Resultado |
|---|---|
| B2 (incl. teste 14) | **14/14** |
| B1 | **10/10** |
| S01+S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

Banco temporário · `CDS_BLOQUEAR_BANCO_OFICIAL=1`

Artefatos: `DIFF-BLOCO-B2-MESA-NUMERO.patch` · `LOG-BLOCO-B2-MESA-NUMERO.txt`
