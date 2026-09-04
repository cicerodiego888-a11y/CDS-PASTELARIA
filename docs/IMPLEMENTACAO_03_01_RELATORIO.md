# SPRINT 03.01 — Auditoria e fundação multiempresa da operação Pastelaria

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — fundação pontual: baixa de estoque da venda usa `empresaIdVenda` e exige empresa; `contas_receber.empresa_id` grava `empresaIdVenda` (sem `req.empresaId || null`).

PDV OFICIAL:  
PDV NORMAL

PDV UNIVERSAL:  
CONGELADO

ARQUIVOS AUDITADOS:  
48

ARQUIVOS ALTERADOS:  
4 (`backend/services/vendas/debitoEstoqueVendaViaPorta.js`, `backend/services/vendas/VendaPagamentoService.js`, `tests/estoque/venda-baixa-empresa-contexto.test.js`, `tests/financeiro/financeiro-multiempresa-05-38-d.test.js`)

ARQUIVOS CRIADOS:  
4 (`tests/pastelaria/fundacao-multiempresa-03-01.test.js`, `docs/arquitetura/AUDITORIA_FUNDACAO_MULTIEMPRESA_PASTELARIA_03_01.md`, `docs/arquitetura/PDV_NORMAL_MULTIEMPRESA_PASTELARIA_03_01.md`, `docs/IMPLEMENTACAO_03_01_RELATORIO.md`)

DOMÍNIOS AUDITADOS:  
19

DOMÍNIOS CORRIGIDOS:  
2 (baixa de estoque do POST de venda; contas a receber da venda)

VENDA:  
`vendas.empresa_id` persistido por `exigirEmpresaDaOperacao`; MULTIEMPRESA sem header bloqueia. Risco residual: modo global MULTIEMPRESA despacha MUV em `POST /api/vendas` (não grava `vendas`) — documentado, não reescrito nesta sprint.

ESTOQUE:  
Isolado em `estoque_empresa`. Baixa do PDV prefere `req.empresaIdVenda` e `exigirEmpresa: true`.

CAIXA:  
`exigirSessaoDaEmpresa` / `exigirCaixaCompativelComVenda` — A não opera B.

PAGAMENTO:  
Dono via `venda_id` → `vendas.empresa_id`. TEF não reimplementado.

FINANCEIRO:  
`financeiro.empresa_id` = `empresaIdVenda`. Contas a receber alinhadas ao mesmo dono.

FISCAL:  
Handoff `empresaIdContexto: venda.empresa_id`. Sem NFC-e/IBS/CBS novos.

RESERVAS:  
05.51–05.53 respeitados; venda A não consome reserva B.

PRODUTOS:  
Catálogo compartilhado; sem `produto_empresa`.

CONVERSÕES:  
Quantidade convertida no PDV Normal; débito no estoque da empresa da venda.

INTEGRAÇÕES:  
Alô Chefia, Cardápio Online e iFood — não implementados (fora do escopo de criar agora).

MATRIZ DE PRONTIDÃO:

| Domínio | Status | Multiempresa | Risco | Próxima ação |
|---------|--------|--------------|-------|--------------|
| Cadastro de empresas | PRONTO | A | baixo | usar no PDV |
| Produtos | PRONTO | B compartilhado | baixo | não criar produto_empresa |
| Estoque | PRONTO | A separado | E COMPAT legado fora do POST | operação Pastelaria |
| PDV Normal | PARCIAL | A no núcleo; D no despacho MULTI global | MUV no POST /api/vendas | alinhar despacho ao núcleo de venda |
| Venda | PRONTO | A no VendaPagamentoService | D se MULTI global | próxima sprint operacional |
| Caixa | PRONTO | A | G header manual | opcional unificar CdsEmpresaContexto |
| Pagamento | PRONTO | A via venda | H TEF | não reimplementar |
| Financeiro | PRONTO | A | baixo | — |
| Fiscal | PARCIAL | A no handoff | H regras novas | não nesta sprint |
| Reservas | PRONTO | A | baixo | não reabrir 05.51–05.53 |
| Pesagem | PARCIAL | equipamento global | H | não alterar drivers |
| Conversões | PARCIAL | A isolamento | cubas/volume específicos | operação Pastelaria |
| Ficha técnica | A IMPLEMENTAR | — | H | não inventar agora |
| Insumos | A IMPLEMENTAR | — | H | com ficha |
| Complementos | A IMPLEMENTAR | — | H | não inventar |
| Cubas | A IMPLEMENTAR | — | H | não inventar |
| Alô Chefia | FORA DO ESCOPO | NÃO IMPLEMENTADA | — | depois da fundação |
| Cardápio | FORA DO ESCOPO | NÃO IMPLEMENTADA | — | depois da fundação |
| iFood | FORA DO ESCOPO | NÃO IMPLEMENTADA | — | depois da fundação |

TESTES:  
20/20 da sprint (mais regressões listadas abaixo)

REGRESSÕES:  
`tests/pastelaria/fundacao-multiempresa-03-01.test.js`  
`tests/vendas/ownership-vendas-05-40.test.js`  
`tests/estoque/venda-baixa-empresa-contexto.test.js`  
`tests/caixa/caixa-multiempresa-05-38-c.test.js`  
`tests/financeiro/financeiro-multiempresa-05-38-d.test.js`  
`tests/estoque/consumo-fisico-reserva-pdv-sem-compat-05-53.test.js`  
`tests/auditoria/isolamento-pdv-universal-05-75.test.js`  
`tests/fiscal/isolamento-nfce-empresa-05-46.test.js`

FALHAS:  
nenhuma (após execução desta sprint)

RISCOS:  
1. POST `/api/vendas` em modo global MULTIEMPRESA → MUV atendimento, não `vendas`.  
2. Link HTML Normal → Universal.  
3. COMPAT de saldo se chamada sem empresa (não o POST PDV).  
4. Pesagem/equipamento não vinculado a empresa.  
5. Integrações Pastelaria ainda inexistentes.

PRÓXIMA SPRINT:  
Implementação operacional da Pastelaria no PDV Normal: alinhar `POST /api/vendas` em MULTIEMPRESA ao núcleo `VendaPagamentoService` (sem evoluir o Universal) e então domínio funcional (não micro-sprints de fundação).
