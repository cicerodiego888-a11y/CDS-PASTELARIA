# SPRINT 03.02 — Consolidação do POST de venda no PDV Normal

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — `VendaApplicationService`: MULTIEMPRESA no POST `/api/vendas` conclui em `VendaPagamentoService` (mesmo núcleo que EMPRESA_UNICA). MUV `criarAtendimento` deixou de ser o caminho do POST.

PDV OFICIAL:  
PDV NORMAL

PDV UNIVERSAL:  
CONGELADO (nenhum arquivo do Universal alterado)

POST /api/vendas:  
`validarCaixaSeOrigemPdv` → `VendaApplicationService.criarVenda` → `concluirVendaNoNucleoOficial` → `VendaPagamentoService.criarVenda`

VendaPagamentoService:  
Núcleo único de persistência da venda do PDV Normal (EMPRESA_UNICA e MULTIEMPRESA).

MUV:  
Preservado para atendimento e PDV Universal. Não é o persistidor do POST. `executarAtendimentoMultiempresa` exportado, não chamado por `criarVendaComContexto`.

PERSISTÊNCIA:  
Um INSERT `vendas` no núcleo, com `empresa_id = empresaIdVenda`. Sem NULL no caminho oficial.

ITENS:  
`vendas_itens` da venda persistida; estoque da mesma empresa.

ESTOQUE:  
03.01 preservado (`empresaIdVenda` + `exigirEmpresa: true`).

PAGAMENTO:  
Núcleo existente; dono via `venda_id` → `vendas.empresa_id`. TEF não reimplementado.

CAIXA:  
`exigirCaixaCompativelComVenda`.

FINANCEIRO:  
`empresaIdVenda` (03.01). Sem `req.empresaId || null`.

FISCAL:  
Handoff `venda.empresa_id`. Sem regras tributárias novas.

RESERVAS:  
05.51–05.53 intactos.

TRANSAÇÃO:  
BEGIN do núcleo após exigência de empresa.

CROSS-COMPANY:  
Bloqueado (venda, caixa, estoque, reservas).

TESTES:  
28/28 (`tests/pastelaria/pos-venda-venda-pagamento-03-02.test.js`)

REGRESSÕES:  
`tests/pastelaria/fundacao-multiempresa-03-01.test.js`  
`tests/vendas/ownership-vendas-05-40.test.js`  
`tests/estoque/venda-baixa-empresa-contexto.test.js`  
`tests/caixa/caixa-multiempresa-05-38-c.test.js`  
`tests/financeiro/financeiro-multiempresa-05-38-d.test.js`  
`tests/estoque/consumo-fisico-reserva-pdv-sem-compat-05-53.test.js`  
`tests/fiscal/isolamento-nfce-empresa-05-46.test.js`  
`tests/vendas/venda-application-service.test.js`  
`tests/muv/modo-operacao-venda-04-02.test.js`  
`tests/muv/atendimento-multiempresa-04-03.test.js`  
`tests/muv/reserva-atendimento-multiempresa-04-04.test.js`

FALHAS:  
nenhuma (após execução desta sprint)

RISCOS:  
1. Materialização MUV ainda pode criar `vendas` por operação (Universal/atendimento, não o POST do Normal).  
2. Menu HTML Normal → Universal.  
3. COMPAT de saldo fora do POST PDV.

PRÓXIMA SPRINT:  
Funcionalidades da Operação Pastelaria no PDV Normal (domínio), sem novo motor de venda.
