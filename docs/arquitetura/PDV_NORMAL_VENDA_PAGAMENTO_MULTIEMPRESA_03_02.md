# PDV Normal — POST de venda via VendaPagamentoService (Sprint 03.02)

## 1. Fluxo anterior

```
PDV Normal → POST /api/vendas
    → VendaApplicationService.criarVenda
        EMPRESA_UNICA → VendaPagamentoService.criarVenda → INSERT vendas
        MULTIEMPRESA  → MUV criarAtendimento
                      → NÃO persiste vendas
                      → venda_concluida: false
```

## 2. Problema da 03.01

O isolamento empresarial já existia em `VendaPagamentoService` (`empresaIdVenda`, estoque, caixa, financeiro). Com modo global **MULTIEMPRESA**, o PDV Normal não usava esse núcleo: o POST virava preview de atendimento MUV.

## 3. Fluxo novo

```
PDV NORMAL
    ↓
POST /api/vendas  (validarCaixaSeOrigemPdv)
    ↓
VendaApplicationService
    ↓  EMPRESA_UNICA | MULTIEMPRESA
concluirVendaNoNucleoOficial
    ↓  origem que conclui (PDV, FATURAMENTO, NF_AVULSA)
VendaPagamentoService.criarVenda
    ↓
resolver empresa (financeiro + exigirEmpresaDaOperacao)
    ↓
exigirCaixaCompativelComVenda
    ↓
empresaIdVenda  →  INSERT vendas (uma vez)
    ↓
itens → pagamento → financeiro → caixa → estoque → fiscal
```

Origens que não concluem: reconhecimento sem persistência (igual a EMPRESA_UNICA).

## 4. VendaPagamentoService

Núcleo oficial único de persistência da venda do POST. Preserva 03.01: `empresaIdVenda`, `exigirEmpresa: true` na baixa, `contas_receber.empresa_id = empresaIdVenda`.

## 5. MUV

Não removido. Continua em:

- `AtendimentoMultiempresaService.criarAtendimento` (chamada direta / testes);
- PDV Universal (`PDVUniversalApplicationService`, congelado);
- `materializarAtendimento` / `fiscalizarAtendimento` no VAS.

`executarAtendimentoMultiempresa` permanece exportado, **fora** de `criarVendaComContexto`. O POST **não** chama `criarAtendimento`. Materialização MUV pode gravar `vendas` por operação de atendimento (caminho Universal / atendimento), não como segundo INSERT do mesmo POST do PDV Normal.

## 6. Persistência

Um `INSERT INTO vendas` por conclusão no núcleo. `vendas.empresa_id = empresaIdVenda` definido **antes** do `BEGIN`. Sem `NULL` no caminho oficial.

## 7. Itens

`vendas_itens.venda_id` da venda recém-inserida. Estoque pela empresa da venda, não do produto.

## 8. Estoque

`montarOpcoesBaixaEstoqueVenda` prefere `req.empresaIdVenda`. POST exige empresa.

## 9. Pagamento

Meios existentes (dinheiro, PIX, débito, crédito, misto, TEF). `venda_pagamentos` sem coluna empresarial; dono = `vendas.empresa_id`. TEF não reimplementado.

## 10. Caixa

`exigirCaixaCompativelComVenda` / `exigirSessaoDaEmpresa`. Venda A não usa sessão B.

## 11. Financeiro

`financeiro.empresa_id` e `contas_receber.empresa_id` = `empresaIdVenda`. Sem `req.empresaId || null`.

## 12. Fiscal

`VendaFiscalService` recebe `empresaIdContexto: venda.empresa_id`. Sem motor fiscal novo.

## 13. Reservas

05.51–05.53 intactos. Consumo usa `reserva.empresa_id`.

## 14. Contexto

MULTIEMPRESA: `X-Empresa-Id` / `req.empresaId`. Sem `empresa_operacional_id` como fallback. Frontend: `CdsEmpresaContexto.anexarHeaderXhr` em `enviarVenda`. Backend é autoridade.

## 15. Transação

`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` já existentes no núcleo. Empresa é exigida **antes** do BEGIN.

## 16. Cross-company

`exigirVendaDaEmpresa` (404 cruzado), caixa divergente 403, reservas divergentes, estoque por `estoque_empresa`.

## 17. Erros

`EMPRESA_CONTEXT_REQUIRED` vs negócio (estoque, pagamento). Cruzado de venda: `VENDA_NAO_ENCONTRADA`.

## 18. Dependências

Rota → VAS → VPS. Sem `pdv-universal` em `frontend/pdv/js` nem em `rotas/vendas.js`.

## 19. PDV Universal

Congelado. Sem alteração nesta sprint. Checkout Universal continua em `/api/pdv-universal/*`.

## 20. Riscos restantes

1. Materialização MUV ainda pode inserir `vendas` por operação — caminho do Universal/atendimento, não do POST do PDV Normal.
2. Link HTML `/pdv-universal/` no menu do Normal (05.75).
3. COMPAT de saldo em chamadas sem empresa (não o POST PDV).
4. Dual-write `produtos` + `estoque_empresa` (legado 03.19).
