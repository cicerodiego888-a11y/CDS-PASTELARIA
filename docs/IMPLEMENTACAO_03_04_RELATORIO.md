# SPRINT 03.04 — Consumo de ficha técnica na venda

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — `VendaPagamentoService` chama `consumirFichaTecnicaDaVenda` na transação oficial após a baixa dos itens; `MotorUnidadesMedida.converterQuantidadeEntreUnidades`; tabelas `venda_ficha_consumo` / `_itens` (idempotência e rastreio). Sem novo motor. PDV Universal não alterado.

PDV OFICIAL:  
PDV NORMAL

PDV UNIVERSAL:  
CONGELADO

FICHA TÉCNICA:  
Compartilhada (03.03). Só cabeçalho ativo gera consumo.

CONSUMO:  
`quantidade vendida × quantidade da ficha`, convertida para a unidade do insumo. `consumirFichaTecnicaDaVenda({ vendaId, empresaId, itens, db })`.

ESTOQUE:  
Porta `debitarEstoqueItemVenda` (`exigirEmpresa: true`). Pré-checagem em `estoque_empresa`.

EMPRESA:  
`empresaId` da venda persistida. Sem `req` como dono.

CONVERSÃO:  
SI no Motor de Unidades (ML↔L etc.). Conversão inválida bloqueia.

ATOMICIDADE:  
Validar tudo → debitar. Falha: ROLLBACK da venda. Sem baixa parcial de ficha.

PRODUTO SEM FICHA:  
Venda normal, sem consumo.

INSUMO:  
Continua `INSUMO_NAO_VENDAVEL` no POST.

FINANCEIRO:  
Inalterado.

CAIXA:  
Inalterado.

FISCAL:  
Uma venda.

MUV:  
Fora do POST.

TESTES:  
35/35 (`tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js`)

REGRESSÕES:  
03.03 25/25 · 03.02 28/28 · 03.01 20/20 · 05.53 10/10 · 05.54 12/12 · 05.55 16/16 · 05.56 10/10 · 05.59 10/10 · 05.64 8/8 · 05.70 12/12 · 05.72 10/10 · 05.74 12/12 · 05.75 PDV Universal 12/12 · 05.76 18/18 · produto-embalagens 14/14 · motor conversão 15/15 · PDV PLU 17/17

FALHAS:  
nenhuma (suite 03.04)

RISCOS:  
1. Estorno de ficha no cancelamento/devolução ainda não existe.  
2. Piso de saldo do writer global em `produtos` vs isolamento em `estoque_empresa`.  
3. Cubas/complementos ainda não implementados.

PRÓXIMA SPRINT:  
Estorno de ficha no cancelamento/devolução **ou** cubas/complementos de açaí, conforme prioridade.
