# SPRINT 03.09

STATUS:  
CONCLUÍDA

TIPO:  
AUDITORIA

BLOCO:  
03 — OPERAÇÃO PASTELARIA

03.01:  
Fundação multiempresa; venda/estoque/caixa/financeiro por empresa. 20/20 OK.

03.02:  
POST `/api/vendas` único via `VendaPagamentoService`. MULTIEMPRESA sem empresa bloqueia. 28/28 OK.

03.03:  
`COMERCIAL`/`INSUMO`; ficha compartilhada; insumo fora do PDV. 25/25 OK.

03.04:  
Consumo na transação da venda; conversão; rollback. 35/35 OK.

03.07:  
Estorno de ficha no cancelamento (snapshot, restante após devolução). 20/20 OK.

03.08:  
Estorno proporcional na devolução; teto; idempotência. 25/25 OK.

MULTIEMPRESA:  
Isolada. EMPRESA_SIMPLES exige operacional se houver várias ativas. MULTIEMPRESA: operacional null.

PRODUTOS:  
Catálogo compartilhado. INSUMO não vendável.

FICHA TÉCNICA:  
Compartilhada. Snapshot na venda. Alteração posterior não reescreve histórico.

VENDA:  
PDV Normal → POST `/api/vendas` → `VendaApplicationService` → `VendaPagamentoService` → `vendas.empresa_id`.

CANCELAMENTO:  
Crédito comercial + estorno restante da ficha na mesma transação. Idempotente.

DEVOLUÇÃO:  
Parcial proporcional; sucessivas; total; sem crédito duplicado na mesma devolução.

ESTOQUE:  
Por `empresa_id` na operação oficial. Dual-write residual (P1 / aceitável em loja única).

COMPRAS:  
Entrada isolada. Leitor `ultimas-compras` sem `empresa_id` (P1 consulta).

INVENTÁRIO/PERDAS:  
FALTANTE. FORA DO FECHAMENTO / P2.

CAIXA:  
Funcional; venda A não usa caixa B.

FINANCEIRO:  
`empresa_id` da venda; F/NF preservados.

FISCAL:  
NFC-e e certificado por empresa. Plataforma Fiscal aposentada (05.80). NF-e 55 fora do critério Pastelaria.

CENTRAL:  
FECHADA. Compatível. Sem reabertura.

PDV UNIVERSAL:  
CONGELADO. Dependências residuais (rotas, menu, adapters). Não evoluir / não remover agora.

P0:  
(nenhum)

P1:  
- Dual-write `produtos` × `estoque_empresa` (risco em duas lojas / mesmo SKU).  
- `GET /produtos/:id/ultimas-compras` e histórico de ajuste sem filtro de empresa.  
- Menu ERP privilegia Universal e chama o PDV oficial de “legado”.  
- Ajuste de estoque COMPAT sem empresa no JWT.

P2:  
- Inventário/perdas.  
- Ranking de produtos sem `v.empresa_id` (MIS).  
- Extra financeiro PUT vs POST no cancelamento.  
- Snapshot da ficha sem split F/NF.

RISCOS ACEITÁVEIS:  
Dual-write com uma empresa operacional. Universal residual. Leitor D só em consulta.

FORA DO ESCOPO:  
Açaíteria, cubas, iFood, Alô Chefia, cardápio, Open Finance, MIS, evolução Central/Universal.

TESTES:  
14/14 (`tests/pastelaria/auditoria-fechamento-bloco3-03-09.test.js`)

REGRESSÕES:  
03.01 20/20 · 03.02 28/28 · 03.03 25/25 · 03.04 35/35 · 03.07 20/20 · 03.08 25/25 · 05.40 13/13 · 05.53 10/10 · 05.54 12/12 · 05.55 16/16 · 05.56 10/10 · 05.59 10/10 · 05.64 T01–T08 OK · 05.70 T01–T12 OK · 05.72 10/10 · 05.74 12/12 · 05.75 PDV 12/12 · 05.75 saúde 13/13 · 05.76 18/18 · 05.77 27/27 · 05.80 13/13.  
05.81: suíte inexistente no repositório (cobertura EMPRESA_SIMPLES na Central = 05.77 T06s).

CONCLUSÃO:  
BLOCO 3 PRONTO

PRÓXIMO PASSO:  
BLOCO 4 — MIS. Não iniciar implementação nesta sprint. Homologar no **PDV Normal** (`/pdv`). P1 de dual-write e menu Universal: pós-go-live ou sprint pontual se a Pastelaria operar duas lojas no mesmo SKU desde o dia 1.
