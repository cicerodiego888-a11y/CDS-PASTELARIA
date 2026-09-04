# SPRINT 03.06

STATUS:  
AUDITORIA CONCLUÍDA

PRODUÇÃO ALTERADA:  
NÃO

FOCO:  
CICLO COMPLETO DA FICHA TÉCNICA (venda → consumo → cancelamento → devolução)

VENDA:  
POST `/api/vendas` → `VendaApplicationService` → `VendaPagamentoService.criarVenda`. Após baixa do item comercial, `consumirFichaTecnicaDaVenda` na mesma `BEGIN IMMEDIATE`. Erro da ficha → ROLLBACK da venda.

CONSUMO:  
`FichaTecnicaConsumoService.montarLinhasConsumo`: ficha ativa × quantidade vendida × conversão MUM → `debitarEstoqueItemVenda` (`exigirEmpresa: true`, `origem: consumo_ficha_tecnica`) → INSERT cabeçalho/itens. Idempotente por `venda_id UNIQUE`.

VENDA_FICHA_CONSUMO:  
Cabeçalho (`venda_id`, `empresa_id`) + itens (`produto_id`, `insumo_id`, `quantidade` já em unidade de estoque, `unidade`, `quantidade_ficha`, `unidade_ficha`). Sem `venda_item_id`, `ficha_id`, status, split F/NF, flag de estorno. Suficiência para estorno: **PARCIAL**.

CANCELAMENTO:  
`PUT /:id/cancelar` e `POST /cancelar/:id`. Ownership `exigirOperacaoReversaoDaVenda`. Credita **produto vendido** (`creditarEstoqueItemVenda` + `vendas.empresa_id`). **Não** lê `venda_ficha_consumo`. Cancelamento parcial de item: **não existe**. Duplo cancel: protegido por status/`cancelada`.

DEVOLUÇÃO:  
`POST /:id/devolver` → `devolverParcial`. Persiste `vendas_devolucoes` (vínculo `venda_item_id`). Credita comercial proporcional. **Sem** vínculo com ficha. Rotas NFe de devolução são fiscais, fora do consumo.

DEVOLUÇÃO PARCIAL:  
EXISTE. Soma anterior impede quantidade > vendida.

DEVOLUÇÃO TOTAL:  
Soma de parciais até o total do item; não é um endpoint separado.

ESTOQUE:  
Débito oficial da venda/ficha: `debitarEstoqueItemVenda`. Crédito oficial cancel/dev: `creditarEstoqueItemVenda` — **reutilizável** para insumos. Empresa do retorno: `resolverEmpresaDaVenda`, não `req` como dono.

CONVERSÃO:  
`MotorUnidadesMedida.converterQuantidadeEntreUnidades` na venda. Snapshot guarda qtd estoque + qtd ficha. T12: alterar ficha depois **não** muda o histórico.

MULTIEMPRESA:  
Consumo e crédito comercial usam `vendas.empresa_id`. Venda A não toca estoque B (T07). Sem empresa 1 / primeira / COALESCE no consumo.

OWNERSHIP:  
Caller B em venda A → `VENDA_NAO_ENCONTRADA` (T15/T16). Estoque da reversão ignora `req.empresaId` como dono (`montarOpcoesRetornoEstoqueDaVenda`).

TRANSAÇÃO:  
Cancel e devolução já têm `BEGIN IMMEDIATE` + ROLLBACK no crédito comercial. Ficha **fora**. Futuro estorno deve entrar **no mesmo BEGIN**.

ROLLBACK:  
Estoque comercial com erro reverte a transação local. Estorno de ficha inexistente → hipótese “comercial OK / ficha falha” **não aplicável hoje**. NFC-e de cancelamento ocorre **antes** do BEGIN (risco pré-existente, P2).

FINANCEIRO:  
`cancelarFinanceiroVenda` / `recalcularFinanceiroDevolucaoVenda`. Sem menção à ficha. Estorno futuro **não** deve criar lançamento extra.

CAIXA:  
Middleware de sessão; audit `caixaSessaoId`; sem movimento de caixa pela ficha.

FISCAL:  
`cancelarNfceAutorizadaVenda`; NFe devolução em rotas próprias. Estorno de insumo deve permanecer só estoque.

PDV:  
Normal → POST `/api/vendas`. Sem novo motor.

PDV UNIVERSAL:  
CONGELADO. Consumo/cancel/devolução da ficha não dependem dele.

AÇAÍTERIA:  
FORA DO ESCOPO. Código de consumo sem cubas/açaí.

GAPS:  
P0 cancel sem estorno de insumo; P0 devolução sem estorno; P0 falta idempotência de estorno (flag). P1 sem `venda_item_id`; P1 split F/NF não persistido. P2 `ficha_id`; PUT vs POST financeiro; NFC-e fora do BEGIN.

P0:  
1. Cancelamento não devolve insumos.  
2. Devolução não devolve insumos.  
3. Sem marca de estorno (duplo crédito se implementado sem flag).

P1:  
`venda_item_id`; buckets fiscal/não fiscal do consumo.

P2:  
`ficha_id`; divergência PUT/POST cancel; ordem NFC-e × transação local.

ARQUIVOS QUE PRECISARÃO DE ALTERAÇÃO (próxima sprint, não agora):  
`FichaTecnicaConsumoService.js`, `VendaCancelamentoService.js`, `VendaDevolucaoService.js`, possivelmente `vendaFichaConsumoSchema.js`.

PRÓXIMA SPRINT RECOMENDADA:  
**03.07 — estorno do consumo no cancelamento (total)**, reutilizando snapshot + `creditarEstoqueItemVenda` no mesmo BEGIN, com idempotência. Devolução proporcional em 03.07 (se couber) ou **03.08**.

TESTES:  
24/24 (`tests/pastelaria/auditoria-ciclo-ficha-tecnica-03-06.test.js`) cobrindo T01–T25 (T02+T03 agrupados).

DOCUMENTO:  
`docs/arquitetura/AUDITORIA_CICLO_FICHA_TECNICA_PASTELARIA_03_06.md`
