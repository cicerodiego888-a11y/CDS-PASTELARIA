# Auditoria de fechamento — Fundação Multiempresa

**Sprint:** 03.34 · **Data:** 2026-08-21  
**Decisão:** **B — FUNDAÇÃO MULTIEMPRESA PARCIAL**

Não houve correção de produção nesta Sprint. Nenhum vazamento simples e isolado foi encontrado para hotfix. A porta pública, o dual-write e os motores não foram alterados.

---

## 1. Estado atual

| Área | Status |
|------|--------|
| Schema `estoque_empresa` | Pronto (03.11). UNIQUE produto+empresa. Sem seed. |
| Serviço isolado | Pronto (03.12 / 03.16). `consultarSaldoParaEmpresa` sem fallback. |
| Backfill | Manual apenas (03.14). Sem automático. |
| Dual-write saldo | Centralizado na porta 03.19. |
| Dual-write reserva | Centralizado na porta 03.20. |
| Writers operacionais HTTP | Com `req.empresaId`: porta + dual-write na empresa correta. |
| Leitores operacionais HTTP migrados | GET, listagem, PDV, venda, entrega, validação compra. |
| Leitura oficial da porta | Ainda `produtos` (`consultarSaldo`). Pedido/MTS veem o saldo global. |
| COMPAT | Intencional quando não há `req.empresaId`. Só `produtos`. |
| Isolamento HTTP | A não altera B nos writers/leitores migrados. |
| Rollback | Transação do caller desfaz `produtos` + `estoque_empresa`. |
| Storage oficial da fase | Continua `produtos`. |

---

## 2. Escritores operacionais (Classe A)

Todos os writers ativos passam pela porta. Dual-write em `estoque_empresa` **somente** com `empresaId` válido. Sem empresa: COMPAT, só `produtos`. Origem HTTP: `req.empresaId` (middleware). Body/query não substituem nos helpers migrados.

| Domínio | Arquivo / função | Rota / caller | Operação | Porta | empresaId | Sem empresa | EE? | Vazamento A/B |
|---|---|---|---|---|---|---|---|---|
| Ajuste | `aplicarAjusteEstoqueProduto` | POST/PUT produtos, importação | ± SF/SNF | `estoqueSaldosPublico` | `empresaIdDoReqAjuste` | COMPAT ajuste | sim se empresa | não, se header |
| CREATE saldo inicial | `aplicarSaldoInicialCreateProduto` | POST produtos | crédito inicial | idem | `req.empresaId` | COMPAT create | sim se empresa | não |
| Recálculo | `recalcularSaldosProduto` | POST recalcular | set via porta | idem | `req.empresaId` | COMPAT recálculo | sim se empresa | não |
| Compra entrada | `creditarEstoqueItemCompra` | POST /api/compras | crédito | `creditarSaldo` | `empresaIdDoReqCompra` | COMPAT crédito | sim se empresa | não |
| Compra cancel/dev | `debitarEstoqueItemCompra` | cancelar / devolver | débito | `debitarSaldo` | idem | COMPAT débito | sim se empresa | não |
| Venda baixa | `debitarEstoqueItemVenda` | POST /api/vendas | débito | `debitarSaldo` | `montarOpcoesBaixaEstoqueVenda` | COMPAT débito venda | sim se empresa | não |
| Venda cancel/dev | `creditarEstoqueItemVenda` | cancelar / devolver / NF-e | crédito | `creditarSaldo` | `empresaIdDoReqCreditoVenda` | COMPAT crédito venda | sim se empresa | não |
| NF-e revert | `reverterEstoqueNfeDevolucaoVenda` | cancelar NF-e dev. venda | débito | `debitarSaldo` | `opcoes.empresaId` | COMPAT revert | sim se empresa | não |
| Reserva PDV/entrega | `reservarItem` / `liberarReservasDaVenda` | venda entrega, cancel | ± reservado | `reservasPublico` | `empresaIdDoReqReservaPdv` | COMPAT reserva PDV | sim se empresa | não |
| Pedido → MC → MTS | `MtsService` via Motor Comercial | confirmar pedido | F↔NF | porta | `params.empresaId` (03.30) | COMPAT certificada | sim se empresa | **leitura** da porta ainda é `produtos` |
| Ponte pedido | `consumirReservasPedidoNaVenda` | faturar / baixa | libera RF | `reservasPublico` | caller | COMPAT ponte | sim se informado | residual `contexto` se empresa ausente |

**Classe B (técnico):** dual-write interno `aplicarEfeitoSaldo` / `aplicarEfeitoReservado` (dentro da porta).  
**Classe C:** backfill 03.14, `migracaoConversaoUnidades` (cadastro).  
**Classe D:** `lotesService.atualizarEstoqueConsolidado` (sem callers).  
**Classe E:** certificação / testes.

Nenhum writer operacional ativo usa `empresaId = 1`, primeiro CNPJ ou inventa empresa.

---

## 3. Leitores operacionais

| Domínio | Arquivo / função | Classe | Contexto | Fonte com empresa | Sem empresa | Risco |
|---|---|---|---|---|---|---|
| GET produto | `resolverSaldosProdutoParaResposta` | A | middleware produtos | `estoque_empresa` / zero | `produtos` | isolado |
| Listagem | `fragmentoEstoqueEmpresaListagem` | A/B | idem | `estoque_empresa` / 0 | `produtos` | isolado |
| PDV identificar | `aplicarSaldosIdentificacaoPdv` | A | idem | EE / zero | payload MIP | isolado |
| Venda PDV | `aplicarSaldosDisponibilidadeVenda` | A | vendas | EE / zero | `produtos` | isolado |
| Venda entrega | `CriarVendaEntregaService` | A | vendas | EE / zero | `produtos` | isolado |
| Cancel/dev compra | `estoqueAtualParaValidacaoCompra` | B | compras | EE.estoqueAtual / 0 | `produtos` | isolado |
| Pedido / MTS | `estoqueSaldosPublico.consultarSaldo` | A | Pedido propaga empresa na **escrita** | **ainda `produtos`** | `produtos` | **agregado global** |
| Motor Comercial | `optsPortaSaldos` → consultarSaldo | A | params | `produtos` | COMPAT | mesmo |

---

## 4. Leituras ainda em `produtos`

### Operacional (próxima fase de leitura oficial)

- `estoqueSaldosPublico.consultarSaldo` — storage oficial da porta (03.19 test 15).
- Pedido / Expedição / MTS disponibilidade e transferência F↔NF leem essa porta.
- Dual-write faz `produtos` acumular deltas de **todas** as empresas; a decisão do Pedido não está isolada.

### Administrativo / visual

Dashboard, relatórios, vencimentos, promoções, GET `/produtos/codigo/:codigo`, CIP, MIB `QueryOptimizer`, `MonitoringAlertService`, listagens de entrega sem overlay.

### Técnico

Backfill (lê `produtos` de origem), schema, porta (escrita oficial).

### Morto

`atualizarEstoqueConsolidado`, `obterProdutoComReserva` (sem callers).

---

## 5. COMPAT

| COMPAT | Fluxo | Motivo | Caller HTTP? | Pode propagar? | Bloqueia visual? | Classe | Próxima ação |
|---|---|---|---|---|---|---|---|
| `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` | MTS / Motor Comercial | fluxo interno sem JWT | indireto (Pedido já envia) | já enviado 03.30 | não | A | manter |
| `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA` | entrada compra | cliente sem header | sim | sim | não | A | manter até header obrigatório |
| `COMPAT_DEBITO_COMPRA_PRE_MULTIEMPRESA` | cancel/dev compra | idem | sim | sim | não | A | manter |
| `COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA` | baixa venda | idem | sim | sim | não | A | manter |
| `COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA` | cancel/dev venda | idem | sim | sim | não | A | manter |
| `COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA` | ajuste | idem | sim | sim | não | A | manter |
| `COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA` | CREATE | idem | sim | sim | não | A | manter |
| `COMPAT_RECALCULO_PRE_MULTIEMPRESA` | recálculo | idem | sim | sim | não | A | manter |
| `COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA` | reserva PDV | idem | sim | sim | não | A | manter |
| `COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA` | NF-e revert | idem | sim | sim | não | A | manter |
| `COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA` | ponte | caller pode omitir | indireto | sim | não | B | apertar montarOpts depois |
| `COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA` | Repair | sem rota HTTP | não | n/a | não | A | manter |

Nenhum COMPAT foi removido.

---

## 6. Contexto empresa

| Domínio | Middleware | `req.empresaId` no service | Porta | Body substitui? | Sem empresa | Status |
|---|---|---|---|---|---|---|
| produtos | `router.use` | sim | writers + overlay leitura | não | COMPAT / legado | OK |
| vendas / PDV / devolução venda | `router.use` | sim | sim | não | COMPAT / legado | OK |
| compras | `router.use` | sim | sim + validação 03.33 | não | COMPAT / legado | OK |
| pedidos | `router.use` | sim até MC/MTS | escrita sim; leitura porta `produtos` | não | COMPAT | parcial |
| faturamento / expedição fila | `router.use` | sim (03.30) | via MC | não | COMPAT | parcial (leitura) |
| entregas (prestação/cancel) | só nessas rotas | sim | reservas | não | COMPAT | OK no writer; GETs admin sem overlay |
| estoque admin GET | obrigatório | sim | n/a (service isolado) | não | 400 | OK |
| importação inicial | `router.use` | sim até ajuste | sim | não | COMPAT | OK |
| ajustes | via produtos | sim | sim | não | COMPAT | OK |
| dashboard | **não** | — | — | — | legado | visual |

Middleware valida empresa ativa e vínculo `usuario_empresas`. Sem header: `req.empresaId = null` (não obrigatório nos routers operacionais).

`empresaIdDoReqOperacional` ainda existe (body/user se anexo nulo) mas **não é usado** pelos writers HTTP migrados.

---

## 7. Integridade produtos → dual-write → estoque_empresa

Confirmado por suítes 03.19–03.33 e teste 03.34:

1. Crédito com empresa vai para a empresa correta.  
2. Débito idem.  
3. Reserva idem.  
4. A não altera B.  
5. Rollback externo desfaz ambos.  
6. Registro inexistente nasce 0 + delta (não copia legado).  
7. Overlay HTTP com empresa e sem registro devolve zero.

`produtos` permanece o acumulador oficial da porta. Isso é o desenho da fundação, não um bug de writer.

---

## 8. Prontidão da camada visual

| Pergunta | Resposta |
|---|---|
| Fonte confiável de empresa ativa? | Sim: tabela `empresas` + middleware. |
| Frontend envia `X-Empresa-Id`? | Sim: `CdsEmpresaContexto` + Ajax ERP + PDV em fluxos migrados. |
| Backend valida empresa ativa? | Sim. |
| Vínculo usuário ↔ empresa? | Sim (`UsuarioEmpresaService`). |
| Trocar sem reiniciar? | Sim (localStorage). **Não há seletor de produto nesta Sprint.** |
| Endpoints críticos HTTP respeitam `req.empresaId`? | PDV, cadastro, compras, baixa, reservas, ajustes: sim. Pedido **escrita** sim; **disponibilidade** via porta ainda `produtos`. |
| Bloqueador técnico para começar o visual? | Não, para PDV/cadastro/compras. Pedido isolado na UI exigiria a próxima fase (leitura oficial). |

**Não foi implementado seletor visual.**

---

## 9. Pendências

### BLOQUEADOR

Nenhum para continuar a fundação nem para iniciar a UI dos módulos já isolados.

### IMPORTANTE (antes de produção multiempresa plena)

`consultarSaldo` da porta (e portanto Pedido / MTS / Motor Comercial na **decisão de disponibilidade**) ainda lê `produtos`. Com duas empresas ativas, o saldo global pode autorizar o que a empresa isolada não tem.

### PRÓXIMA FASE (visual / administrativo)

Seletor de empresa, dashboard, relatórios, MIB, GET por código, overlays de listagens de entrega.

### FUTURO

Tornar header obrigatório, remover COMPAT, backfill automático, desligar `produtos` como storage oficial.

---

## 10. Decisão

**B — FUNDAÇÃO MULTIEMPRESA PARCIAL**

A fundação de **escrita** (porta + dual-write + contexto HTTP) e os **leitores HTTP** que esta fase podia migrar estão isolados, sem empresa inventada e sem fallback silencioso.

A fundação **não** está APROVADA no sentido estrito (“todos os fluxos operacionais críticos isolados”) porque a **leitura oficial da porta** — usada por Pedido / Expedição / MTS — permanece em `produtos`. Isso é o desenho 03.19, não um hotfix. A transição dessa leitura é a próxima fase, não um defeito a corrigir nesta Sprint.

Sprint **03.35 não iniciada**.
