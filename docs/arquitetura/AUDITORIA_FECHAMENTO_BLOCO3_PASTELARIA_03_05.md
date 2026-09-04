# Auditoria de fechamento do Bloco 3 — Operação Pastelaria (Sprint 03.05)

TIPO: AUDITORIA (sem implementação funcional)  
STATUS: CONCLUÍDA (fotografia)  
PRODUÇÃO ALTERADA: NÃO  
PASTELARIA ≠ AÇAÍTERIA  
PDV OFICIAL: PDV Normal (`/pdv`, `frontend/pdv`)  
PDV UNIVERSAL: CONGELADO (05.75) — não evoluir, não corrigir, não migrar  
CENTRAL DE ENTRADAS: FECHADA (05.76) — não reabrir sem falha concreta  

Invariante: produto compartilhado → estoque por empresa → venda/financeiro/caixa/fiscal da empresa. Contexto autoriza; ownership persistido determina. Nenhum fallback empresarial (empresa 1, primeira/última, `empresa_operacional` em MULTIEMPRESA, COMPAT-as-ownership, COALESCE de dono).

Código compartilhado com outros produtos CDS (Açaíteria ou núcleo comum) é marcado **COMPARTILHADO**. Não entra no escopo da Pastelaria só por existir no repositório.

---

## 1. O que já está realmente pronto (após 03.01–03.04)

| Capacidade | Evidência |
|------------|-----------|
| Fundação multiempresa no PDV Normal | 03.01: `X-Empresa-Id`, `empresaIdVenda`, caixa `exigirSessaoDaEmpresa`, `contas_receber.empresa_id` = venda |
| POST oficial de venda | 03.02: EMPRESA_UNICA e MULTIEMPRESA → `VendaApplicationService` → `VendaPagamentoService.criarVenda`. MUV não persiste o POST |
| Catálogo COMERCIAL / INSUMO | 03.03: `produtos.tipo_operacional`; insumo bloqueado na venda (`INSUMO_NAO_VENDAVEL`); sem `produto_empresa` |
| Ficha técnica compartilhada | `ficha_tecnica` / `ficha_tecnica_itens` sem `empresa_id` |
| Consumo na venda | 03.04: `consumirFichaTecnicaDaVenda` na transação; `exigirEmpresa: true`; pré-checagem `estoque_empresa`; ROLLBACK se falha |
| Caixa da empresa da operação | `CaixaEmpresaContextoService` + header no PDV (`caixa.js`, `pdv.js`) |
| Compras / Central | Compras com `empresa_id`; Central fechada 05.76 |

Cubas, complementos de açaí, Alô Chefia, cardápio online e iFood **não** estão prontos e **não** são requisito automático da Pastelaria.

---

## 2. A) Cadastro de produtos

| Item | Status | Classe | Notas |
|-------|--------|--------|-------|
| Produto comercial | PRONTO | A | `tipo_operacional = COMERCIAL` |
| Insumo | PRONTO | A | Não vendável no núcleo da venda |
| Unidades / conversões | PRONTO | A | `MotorUnidadesMedida` no consumo da ficha |
| Ficha técnica / ingredientes | PRONTO | B | Compartilhada (todas as lojas veem a mesma receita) |
| Produtos inativos | PRONTO | A | Cadastro `ativo`; consumo ignora ficha inativa |
| Vendáveis no PDV | PRONTO | A | Filtro de insumo no POST; listagem PDV via MIB/Search |
| Catálogo compartilhado | PRONTO | B | `produtos` sem `empresa_id`; correto para Pastelaria |
| ERP `GET /produtos` lista insumos | RISCO | B/C | Isolamento de catálogo ok; mistura operacional no ERP |
| Edição da ficha | RISCO | C | Alterar receita em A muda consumo futuro de B (desenho, não bug de SQL) |

**Status domínio: PRONTO** (operação de cadastro). Riscos de desenho compartilhado, não de ownership SQL.

---

## 3. B) PDV Normal

| Item | Status | Classe |
|-------|--------|--------|
| Abertura / seleção / quantidade / preço / descontos | PRONTO | A/G |
| Pagamentos / misto / fechamento | PRONTO | A |
| Venda multiempresa + contexto | PRONTO | A | 03.02 + `X-Empresa-Id` |
| Estoque / financeiro / caixa / fiscal (handoff) | PRONTO | A | Núcleo oficial |
| Cancelamento / devolução da **venda** | PARCIAL | A + pendência ficha |
| TEF | PARCIAL | E | Núcleo existente; não reimplementado na 03.x |

Núcleo de venda **não** foi alterado nesta sprint.

**Status domínio: PARCIAL** — venda à vista/prazo no PDV Normal está operacional; o ciclo de vida após a venda ainda falha no consumo de insumos (ver I).

---

## 4. C) Estoque

| Item | Status | Classe |
|-------|--------|--------|
| Entrada (compras) | PRONTO | A | `compras.empresa_id` |
| Saída / baixa de venda (item comercial) | PRONTO | A | Porta + `exigirEmpresa: true` no POST |
| Baixa de insumo (ficha) | PRONTO | A | 03.04, mesma empresa da venda |
| Ajustes | PARCIAL | E | `ajusteEstoqueService` ainda tem COMPAT se JWT sem empresa |
| Inventário / contagem física | FALTANTE | E | Sem módulo `inventario` / contagem no backend |
| Perdas (domínio) | FALTANTE | E | Sem writer de perdas; MIB “perdas evitadas” não é operação |
| Estoque por empresa + produto compartilhado | PRONTO | A | `estoque_empresa` UNIQUE (produto_id, empresa_id) |
| Dual-write `produtos` (piso global) vs `estoque_empresa` | RISCO | D | Writer de saldo ainda valida/espelha `produtos`; 03.04 mitiga no consumo com pré-checagem empresarial |
| COMPAT débito sem `exigirEmpresa` | RISCO | E | Fora do POST PDV e do consumo 03.04 |

**Status domínio: PARCIAL.** Isolamento A no caminho oficial da venda; **D** no writer dual; inventário/perdas não existem como operação Pastelaria.

---

## 5. D) Ficha técnica

| Item | Status |
|------|--------|
| Cadastro / edição / ativo | PRONTO (03.03) |
| Conversões no consumo | PRONTO | SI via Motor de Unidades |
| Consumo na venda | PRONTO (03.04) |
| Saldo insuficiente | PRONTO | Bloqueia venda (pré-checagem agregada) |
| Insumo inativo | PRONTO | Contrato 03.04 |
| Rollback (falha no consumo) | PRONTO | Validar tudo → debitar; `ROLLBACK` da transação da venda |
| Estorno no cancelamento | **FALTANTE** | `VendaCancelamentoService` não referencia ficha / `venda_ficha_consumo` |
| Estorno na devolução | **FALTANTE** | `VendaDevolucaoService` idem |

Hoje: cancelar ou devolver **credita o item comercial vendido** e **não** devolve os insumos debitados pela ficha. O registro `venda_ficha_consumo` permanece. **Não corrigido nesta auditoria.**

**Status domínio: PARCIAL.** P0 para fechar operação correta de estoque após cancel/devolução.

---

## 6. E) Compras / entradas (somente Pastelaria)

| Item | Status | Classe |
|-------|--------|--------|
| Compra manual / itens / fornecedor | PRONTO | A | Rotas `compras.js`, `empresa_id` obrigatório no financeiro |
| Entrada de mercadoria → estoque | PRONTO | A |
| Integração Central de Entradas | PRONTO (fechada) | A | 05.76; não reabrir |
| Documentos fiscais de entrada | PARCIAL | A/E | Via Central já fechada; DistDFe legado residual 05.76 |
| Histórico de custo do produto (`GET` compras do produto) | RISCO | D | JOIN `compras` **sem** `c.empresa_id` (`produtos.js` histórico) |

**Status domínio: PARCIAL** por leitor D no histórico de produto; operação de compra em si está A. Central **não** reaberta.

---

## 7. F) Caixa

| Item | Status | Classe |
|-------|--------|--------|
| Abertura / movimentações / fechamento | PRONTO | A |
| Pagamentos da venda | PRONTO | A via `caixa_sessao_id` + empresa da venda |
| Empresa | PRONTO | `exigirSessaoDaEmpresa` |
| Cancelamentos vs caixa | PARCIAL | A no núcleo; conferir divergência operacional no dia a dia |
| Header no front | G | `caixa.js` / `pdv.js` enviam `X-Empresa-Id` |

PDV Normal usa o caixa da empresa da operação quando o contexto HTTP está presente. **Status: PRONTO** no contrato; **G** se o operador omitir o header.

---

## 8. G) Financeiro

| Item | Status | Classe |
|-------|--------|--------|
| Contas a receber da venda | PRONTO | A | `empresaIdVenda` |
| Contas a pagar da compra | PRONTO | A | `empresa_id` obrigatório |
| Pagamentos / cancelamentos (títulos da venda) | PRONTO | A via ownership da venda |
| Open Finance | FORA DO ESCOPO | H | BLOCO 5 |

**Status domínio: PRONTO** para operação. Open Finance **não** fecha o Bloco 3.

---

## 9. H) Fiscal (escopo Pastelaria)

| Item | Status | Classe |
|-------|--------|--------|
| NFC-e (65) emissão / cancelamento / empresa da venda | PRONTO | A | Handoff `venda.empresa_id` (`VendaFiscalService`) |
| Contingência | PARCIAL | E | Se já existir no núcleo fiscal **COMPARTILHADO**; não expandir nesta auditoria |
| NF-e modelo 55 | FORA DO ESCOPO (fechar Bloco 3) | E/COMPARTILHADO | Código existe (`nfeAvulsaService`, `rotas/nfe.js`); **não** é requisito oficial da operação Pastelaria; não importar decisões da Açaíteria |

**Status domínio: PARCIAL** — NFC-e no caminho da venda está no núcleo; não criar/evoluir 55 para “fechar” o Bloco 3.

---

## 10. I) Cancelamento / devolução

| Superfície | O que acontece hoje |
|------------|---------------------|
| Estoque do **item vendido** | Crédito pela porta / serviços de cancelamento e devolução, empresa da **venda persistida** (05.42) |
| Financeiro / caixa / fiscal | Núcleos existentes; dono = venda |
| Insumos da ficha | **Não estornados** |
| `venda_ficha_consumo` | **Não revertido** |

**Status: PARCIAL / P0** para estoque de insumos. Não implementar nesta sprint.

---

## 11. J) Relatórios operacionais vs MIS

| Tipo | Exemplos | Destino |
|------|---------|---------|
| OPERACIONAL | Listagem de vendas do PDV/ERP filtrada por `v.empresa_id`; caixa da sessão; estoque da empresa no ERP quando há `req.empresaId` | Bloco 3 |
| MIS / gestão consolidada | Ranking de produtos **sem** `vendas.empresa_id` (`sqlRankingProdutos`); dashboards MIB; “perdas evitadas” | BLOCO 4 (MIS) |
| Open Finance / consolidado bancário | — | BLOCO 5 |

**Status: PARCIAL.** Relatórios necessários ao caixa/venda do dia existem; ranking global é **D** e não deve ser tratado como relatório oficial da loja. **Não implementar MIS nesta sprint.**

---

## 12. Integrações

| Integração | Existe no código Pastelaria? | Escopo Pastelaria? |
|------------|-------------------------------|---------------------|
| Alô Chefia | NÃO EXISTE | Não assumir. Decisão de produto futura; **não** copiar Açaíteria |
| Cardápio Online | NÃO EXISTE | Idem |
| iFood | NÃO EXISTE | Idem |

Menções em docs 03.01/03.03 são backlog antigo misturado. **Não** fecham o Bloco 3.

---

## 13. Multiempresa transversal (A–E)

| ID | Risco | Classe | Onde |
|----|-------|--------|------|
| R1 | Dual-write saldo `produtos` + `estoque_empresa` | **D** | Porta de débito/ajuste; piso global pode divergir do saldo da loja |
| R2 | `sqlRankingProdutos` soma vendas de todas as empresas | **D** | `reportFiscalHelpers.js` |
| R3 | Histórico de compras do produto sem filtro de empresa | **D** | `backend/rotas/produtos.js` |
| R4 | Ficha compartilhada: A altera receita de B | C (desenho) | `ficha_tecnica` sem `empresa_id` — **intencional** 03.03 |
| R5 | COMPAT ajuste/débito sem empresa | E | `ajusteEstoqueService`, `debitoEstoqueVendaViaPorta` se `exigirEmpresa` false |
| R6 | Cancel/devolução sem estorno de ficha | A no item vendido; **falha de domínio** nos insumos | Cancelamento/devolução |
| R7 | Menu HTML Normal → Universal | E/G | 05.75 |
| R8 | NF-e 55 / avulsa | E / COMPARTILHADO | Fora do fechamento Pastelaria |
| R9 | Listagem ERP de produtos (insumos visíveis) | B | Catálogo compartilhado |
| R10 | `PoliticaMultiempresa.resolverEmpresaOperacionalContrato` = null | A | Sem fallback operacional em MULTI |

Caminho oficial PDV + consumo 03.04: **A**.  
Leituras de ranking/histórico produto: **D**.  
COMPAT: **E**, não usado no POST com `exigirEmpresa: true`.

---

## 14. Writers de produção (inventário — não alterar)

| Arquivo | Função | Tabela | empresa_id | Fonte | Risco |
|---------|--------|--------|------------|-------|-------|
| `VendaPagamentoService.js` | `criarVenda` | `vendas` | sim | `empresaIdVenda` | A |
| `VendaPagamentoService.js` | itens | `vendas_itens` | via `venda_id` | venda | A |
| `VendaPagamentoService.js` | parcelas | `contas_receber` | sim | `empresaIdVenda` | A |
| `VendaPagamentoService.js` | títulos | `financeiro` | sim | `empresaIdVenda` | A |
| `VendaPagamentoService.js` | pagamentos | `venda_pagamentos` | via venda | venda | A |
| `debitoEstoqueItemVenda` | baixa item / ficha | `estoque_empresa` + `produtos` | exige se `exigirEmpresa` | venda / consumo | A no POST; **D** dual-write |
| `FichaTecnicaConsumoService.js` | `consumirFichaTecnicaDaVenda` | `venda_ficha_consumo` (+ itens) | sim | `vendas.empresa_id` | A |
| `FichaTecnicaService.js` | `salvar` | `ficha_tecnica` / `_itens` | **não** | N/A (compartilhado) | B |
| `ajusteEstoqueService.js` | ajuste | `produtos` / `estoque_empresa` | opcional + COMPAT | JWT / contexto | E |
| `compras.js` | persistir compra | `compras` / `compras_itens` / `financeiro` | sim | contexto compra | A |
| `VendaCancelamentoService.js` | cancelar | venda + estoque item | empresa da venda | persistido | A item; ficha FALTANTE |
| `VendaDevolucaoService.js` | devolver | idem | empresa da venda | persistido | A item; ficha FALTANTE |
| `VendaFiscalService` / `emissor.js` | NFC-e | notas fiscais | empresa da venda | persistido | A |
| Central (fechada) | documentos | `central_entradas_documentos` | sim | 05.54–05.76 | A; **não reabrir** |
| PDV Universal | writers MUV | — | — | legado | E **CONGELADO** |

---

## 15. Readers críticos (inventário — não corrigir)

| Reader | Isolamento | Risco |
|--------|------------|-------|
| Listagens de vendas (`rotas/vendas.js`) | `v.empresa_id = ?` | A |
| Detalhe venda por ID + `exigirVendaDaEmpresa` | ownership persistido | A |
| `estoque_empresa` por produto+empresa | A | A |
| Fragmento listagem estoque ERP | `req.empresaId` | A se header; C se ausente |
| `GET /produtos` ERP | catálogo global | B |
| `sqlRankingProdutos` | **sem empresa** | **D** |
| Histórico compras do SKU | sem empresa | **D** |
| Dashboards MIB | não operacional loja | E / MIS |
| GET Central `/saude` | isolado 05.76 | A |
| PDV Universal telas | legado | E congelado |

---

## 16. PDV Universal — dependências (somente registro)

Não evoluir. Dependências já mapeadas na 05.75:

- `frontend/pdv-universal/`
- `backend/rotas/pdv-universal.js`
- `PDVUniversalApplicationService.js`
- Menu ERP / atalho HTML do Normal
- MUV atendimento (não é o POST do Normal após 03.02)

Remoção só após auditoria futura de chamadores, testes e navegação.

---

## 17. Matriz final do Bloco 3

| Domínio | Status | Prioridade | Sprint sugerida |
|---------|--------|------------|-----------------|
| Cadastro produtos COMERCIAL/INSUMO | PRONTO | P1 | — |
| Ficha cadastro compartilhada | PRONTO | P1 | — |
| PDV Normal venda + POST núcleo | PRONTO | P0 | — (já 03.02) |
| Consumo ficha na venda | PRONTO | P0 | — (já 03.04) |
| Caixa empresa | PRONTO | P0 | — |
| Financeiro venda/compra | PRONTO | P0 | — |
| NFC-e no núcleo | PRONTO | P1 | — (não expandir 55) |
| Compras entrada | PARCIAL | P1 | Isolar leitor histórico produto (opcional P2) |
| Estoque isolamento venda | PRONTO | P0 | — |
| Dual-write estoque | RISCO | P1 | Endurecer writer (após estorno ficha) |
| Inventário / perdas | FALTANTE | P2 | Só se a operação Pastelaria exigir contagem |
| Estorno ficha cancel/devolução | FALTANTE | **P0** | **03.06** |
| Relatórios ranking global | RISCO | P2 | Isolar **ou** mover para MIS (Bloco 4) |
| Open Finance | FORA DO ESCOPO | — | Bloco 5 |
| MIS / consolidado | FORA DO ESCOPO | — | Bloco 4 |
| Portal contador / vendedor | FORA DO ESCOPO | — | — |
| Cubas / complementos açaí | FORA DO ESCOPO | — | **Açaíteria** — nunca 03.06 |
| Alô Chefia / cardápio / iFood | NÃO EXISTE | P3 | Só se produto Pastelaria decidir |
| PDV Universal | FORA DO ESCOPO | — | Congelado |
| Central Entradas | PRONTO | — | Fechada 05.76 |

---

## 18. O que falta para a Pastelaria operar / o que bloqueia

**Pode operar venda do dia** (PDV Normal, estoque da loja, caixa, financeiro, NFC-e, consumo de ficha na venda).

**Bloqueia operação correta (P0):** cancelamento e devolução **sem** estorno dos insumos da ficha — saldo da loja fica errado após estorno de venda.

Não bloqueia: MIS, Open Finance, iFood, cubas, NF-e 55, inventário formal (P2).

Melhoria (P2): ranking isolado, histórico de compras por empresa, listagem ERP sem insumos, dual-write.

---

## 19. Próxima sprint e estimativa

**Próxima implementação: Sprint 03.06 — estorno do consumo de ficha técnica no cancelamento e na devolução**, usando `venda_ficha_consumo` / `_itens` e `vendas.empresa_id`, com `exigirEmpresa: true`. Sem cubas. Sem PDV Universal. Sem Open Finance. Sem MIS. Sem reabrir Central.

Sprints aproximadas para **fechar o Bloco 3** (só Pastelaria):

1. **03.06** — estorno ficha (P0) — obrigatória  
2. **Opcional 03.07** — dual-write / COMPAT fora do caminho oficial (P1 risco D)  
3. **Opcional** — inventário/perdas **somente** se for requisito declarado da Pastelaria (hoje FALTANTE, P2)

**Estimativa: 1 sprint para desbloquear; 2–3 no total** se incluir endurecimento de estoque e um relatório operacional isolado. Integrações, MIS e Open Finance **não** entram nessa conta.

---

## 20. Respostas objetivas

1. **Pronto:** fundação ME, PDV Normal no núcleo, tipos de produto, ficha compartilhada, consumo na venda, caixa/financeiro da empresa, NFC-e handoff, Central fechada.  
2. **Falta:** estorno ficha; inventário/perdas se forem operação; isolamento de alguns leitores D.  
3. **Bloqueia:** estorno ficha (estoque de insumos após cancel/devolução).  
4. **Melhoria:** ranking, histórico compras, dual-write, ERP sem insumos.  
5. **Riscos ME:** R1–R3 (D); COMPAT E; ficha compartilhada C.  
6. **Implementar:** 03.06 estorno; depois riscos D se P1.  
7. **Próxima sprint:** 03.06 estorno ficha.  
8. **Quantas sprints:** ~1 obrigatória + até 2 opcionais de isolamento/estoque = **cerca de 2–3**.

Testes desta auditoria: `tests/pastelaria/auditoria-fechamento-bloco3-03-05.test.js` (T01–T16).
