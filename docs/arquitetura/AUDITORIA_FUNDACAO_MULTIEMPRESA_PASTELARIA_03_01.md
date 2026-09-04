# Auditoria e fundação multiempresa — Pastelaria (Sprint 03.01)

Auditoria do **PDV Normal** e dos núcleos que ele aciona. PDV Universal permanece **congelado**. Catálogo de produtos permanece **compartilhado**. Estoque, venda, caixa e financeiro permanecem **por empresa**.

Regra de ownership: o contexto **autoriza**; a entidade persistida **define o dono**. Sem primeira/última empresa, empresa 1, `COALESCE` empresarial ou COMPAT como dono.

Classificação: **A** multiempresa correto · **B** compartilhado correto · **C** contexto ausente · **D** risco de cruzamento · **E** legado/compat · **F** teste · **G** UI · **H** fora do Bloco 3.

---

## 1. Arquitetura encontrada

O CDS já possui modo operacional global `EMPRESA_SIMPLES` | `MULTIEMPRESA`, `CdsEmpresaContexto` / `X-Empresa-Id`, `estoque_empresa`, ownership de venda (05.40–05.42), caixa (05.38.C), financeiro (05.38.D), reservas (05.51–05.53) e Central de Entradas empresarial.

Há **dois caminhos de PDV**: Normal (`/pdv`, `frontend/pdv`) oficial; Universal (`/pdv-universal`) legado congelado (05.75).

Há **dois despachos de POST `/api/vendas`**: `EMPRESA_UNICA` → `VendaPagamentoService` (grava `vendas`); `MULTIEMPRESA` global → MUV `criarAtendimento` (**não** grava `vendas`). O PDV Normal envia o POST oficial para `/api/vendas`. Isso é o principal risco operacional do Bloco 3 (ver §20).

## 2. PDV Normal

Fluxo: abertura de caixa → busca produto (catálogo compartilhado) → inclusão/quantidade/desconto/total → `enviarVenda` anexa `X-Empresa-Id` → `POST /api/vendas` → estoque / pagamento / financeiro / caixa / fiscal.

| Etapa | Origem de empresaId | Validação | Persistência | Onde pode se perder |
|-------|---------------------|-----------|--------------|---------------------|
| Abertura | `CdsEmpresaContexto` + caixa | `validarCaixaAberto` + `exigirSessaoDaEmpresa` | `caixa_sessoes.empresa_id` | Header omitido em alguns XHR de caixa (**G**) |
| Produto | N/A (compartilhado) | — | `produtos` sem `empresa_id` | — |
| Inclusão | Contexto de sessão | Backend na finalização | Itens via `venda_id` | Quantidade convertida no cliente antes do POST |
| Pagamento | Mesmo header da venda | `exigirEmpresaDaOperacao` | `venda_pagamentos` via `venda_id` | Tabela de pagamentos sem `empresa_id` próprio (**A** via join) |
| Finalização | Header + `req.empresaId` após financeiro | `exigirEmpresaDaOperacao` + caixa compatível | `vendas.empresa_id` | Despacho MUV se modo global MULTI (**D**, próxima sprint) |
| Estoque | `empresaIdVenda` na baixa | `exigirEmpresa: true` no PDV | `estoque_empresa` dual-write | COMPAT se débito legado sem empresa (**E**, fora do POST PDV) |
| Financeiro | `empresaIdVenda` | Resolver financeiro + exigir operação | `financeiro.empresa_id` | — |
| Fiscal | `venda.empresa_id` | Emissor existente | NFC-e existente | Sem novas regras nesta sprint |

**A** no caminho EMPRESA_UNICA / `VendaPagamentoService`. **D** se a instalação estiver em MULTIEMPRESA global: o PDV Normal não conclui `vendas`.

## 3. PDV Universal

Congelado (05.75). Não evoluir, não adaptar a Pastelaria, não remover. Navegação HTML do Normal ainda aponta para `/pdv-universal/` (**E/G**, risco registrado; JS do Normal não importa o Universal).

## 4. Venda

`POST /api/vendas` → `VendaApplicationService.criarVenda` → (EMPRESA_UNICA) `VendaPagamentoService.criarVenda`.

`resolverEmpresaIdParaVenda`: MULTIEMPRESA exige `X-Empresa-Id` / `req.empresaId`; **não** usa `empresa_operacional_id`. EMPRESA_SIMPLES usa contrato operacional.

`exigirEmpresaDaOperacao` bloqueia `NULL`. INSERT em `vendas` inclui `empresa_id` = `empresaIdVenda`. **A**.

## 5. Itens

`vendas_itens` liga-se à venda, sem `empresa_id` próprio. Baixa usa empresa da operação da venda, não do produto. **A**.

## 6. Estoque

Porta: `estoqueSaldosPublico` + dual-write `estoque_empresa`. Venda A não deve debitar B (03.25 / T03–T04). Cancelamento usa `resolverEmpresaDaVenda` e ignora `req.empresaId` (**A**, 05.42).

COMPAT de débito/crédito ainda existe para chamadas sem empresa (**E**). O POST de venda do PDV passou a `exigirEmpresa: true`.

## 7. Caixa

`CaixaEmpresaContextoService.exigirSessaoDaEmpresa`. Sessão A vs contexto B → `CAIXA_SESSAO_EMPRESA_DIVERGENTE`. **A**. Front `caixa.js` monta `X-Empresa-Id` via `localStorage` (mesmo storage que `CdsEmpresaContexto`) — **G**, não ownership.

## 8. Pagamentos

Dinheiro/PIX/débito/crédito/misto/TEF: núcleo existente. `venda_pagamentos` sem coluna empresarial; dono = `vendas.empresa_id`. TEF não reimplementado. **A** via venda. **H** reimplementar TEF.

## 9. Financeiro

`INSERT INTO financeiro` usa `empresaIdVenda`. `contas_receber.empresa_id` corrigido nesta sprint (antes `req.empresaId || null` — **D**). **A**.

## 10. Fiscal

`VendaFiscalService.emitirFiscalSeSolicitado` passa `empresaIdContexto: venda.empresa_id`. Sem NFC-e nova, IBS/CBS ou reforma. **A** no handoff. Núcleo fiscal em si: sprints fiscais anteriores.

## 11. Reservas

Não reabrir 05.51–05.53. `EstoqueConsumoReserva` usa `reserva.empresa_id`; caller só autoriza; venda deve coincidir. **A**.

## 12. Produtos

`produtos` sem `empresa_id`. Sem `produto_empresa`. **B**.

## 13. Conversões

PDV Normal: `obterQuantidadeEstoqueParaVenda` (PESO / UNIDADE via `peso_medio_unidade`). Conversão no cliente; débito no estoque da empresa da venda. Volume (ex.: L → copo 200 ml) usa o mesmo padrão de quantidade base. **A** no isolamento; **PARCIAL** para cubas/açaí específicos.

## 14. Ficha técnica

Não há motor de ficha técnica operacional no PDV. **A IMPLEMENTAR** / não inventar. **H** remodelar agora.

## 15. Insumos

Regra de negócio (insumos não vendáveis no PDV) não auditada como feature nova. Consumo empresarial só existirá quando a ficha existir. **A IMPLEMENTAR**.

## 16. Integrações

Busca no código: sem Alô Chefia, Cardápio Online ou iFood implementados. **NÃO IMPLEMENTADA** / **FORA DO ESCOPO** desta sprint.

## 17. Frontend

`frontend/shared/js/cds-empresa-contexto.js`: `X-Empresa-Id`. PDV `enviarVenda` usa `anexarHeaderXhr`. **A/G**. Frontend não é dono.

## 18. Contexto

`ContratoOperacionalService` + resolvers por domínio. MULTIEMPRESA: contexto explícito. EMPRESA_SIMPLES: empresa operacional do contrato. **A**.

## 19. SQL

Crítico: `INSERT vendas` / `financeiro` / `contas_receber` com `empresa_id`. Leituras de venda por `id` sem empresa nas reversões passam por `exigirVendaDaEmpresa` / `resolverEmpresaDaVenda`. `venda_pagamentos` WHERE `venda_id` (**A** indireto).

Não se alteraram SELECTs só por estética.

## 20. Riscos (não corrigidos nesta sprint)

1. **D/H** — Com modo global `MULTIEMPRESA`, `POST /api/vendas` despacha MUV e **não** persiste `vendas`. O PDV Normal da Pastelaria precisa do núcleo `VendaPagamentoService`. Próxima sprint de implementação operacional.
2. **E/G** — Link `/pdv-universal/` em `frontend/pdv/index.html`.
3. **E** — COMPAT de débito/crédito em chamadas sem empresa (não o POST PDV).
4. **H** — Equipamento/balança global (não vinculado a empresa); drivers intocados.
5. **H** — Dual-write ainda espelha `produtos` (consolidado legado 03.19).
6. **C/G** — Alguns XHR de caixa/entrega montam header manualmente em vez de `CdsEmpresaContexto`.

## 21. Correções realizadas

1. Baixa de estoque da venda: `montarOpcoesBaixaEstoqueVenda` prefere `req.empresaIdVenda`; POST exige `exigirEmpresa: true`.
2. `contas_receber.empresa_id` passa a `empresaIdVenda` (sem `NULL` por `req.empresaId`).

Nenhum fallback perigoso (empresa 1, primeira empresa, COMPAT-as-ownership) foi introduzido.

## 22. Pendentes (próximas sprints do Bloco 3)

- Rota PDV Normal em MULTIEMPRESA global → persistir venda empresarial (não MUV preview).
- Operação Pastelaria: cardápio, cubas, ficha, insumos, Alô Chefia, iFood.
- Pesagem por empresa, se o domínio exigir.
- Remover ou isolar o atalho HTML para o Universal (sem evoluir o Universal).
