# INVENTÁRIO DE WRITERS OPERACIONAIS — Sprint 05.39

**STATUS:** AUDITORIA — SOMENTE LEITURA  
**Data:** 2026-08-24  

Critério: writer = função que executa `INSERT` / `UPDATE` / `DELETE` (ou porta pública equivalente) em tabela operacional.  
`RECEBE empresaId?` = parâmetro/contexto explícito na chamada.  
`PERSISTE empresa_id?` = coluna gravada na tabela alvo.  
`FALLBACK?` = COMPAT, `|| null`, LIMIT 1, config global, primeira sessão.

---

## Writers

| WRITER | OPERAÇÃO | TABELAS | RECEBE empresaId? | PERSISTE empresa_id? | FALLBACK? | STATUS |
|--------|----------|---------|-------------------|----------------------|-----------|--------|
| `VendaPagamentoService.criarVenda` | Criar venda legado | `vendas`, `vendas_itens`, `venda_pagamentos` | Sim (`req.empresaId` após `resolverEmpresaIdParaFinanceiro`) | **Não** em `vendas` | Caixa herda empresa (`validarCaixaAberto.js:114`) | 🟡 PARCIAL |
| `VendaPagamentoService.criarVenda` (satélite) | Receita / prazo | `financeiro`, `contas_receber` | Sim | Sim (`req.empresaId \|\| null`) `:1642-1660`, `:1247-1249` | `\|\| null` | 🟡 PARCIAL |
| `VendaPagamentoService.gravarRecebimentos` | Recebimentos | `venda_recebimentos` | Indireto (`req`) | **Não** | — | 🟡 PARCIAL |
| `MaterializarOperacoesAtendimento.persistirVendaOperacao` | Venda MUV | `vendas`, `vendas_itens`, `venda_pagamentos` | Sim (`operacao.empresaId`) `:164` | **Não** em `vendas` `:177-181` | — | 🟡 PARCIAL |
| `MaterializarOperacoesAtendimento.persistirVendaOperacao` (fin) | Receita MUV | `financeiro` | Sim (em memória) | **Não** `:226-231` | omitido | 🔴 RISCO |
| `CriarVendaEntregaService` | Venda entrega | `vendas` | Contexto HTTP | **Não** (`:261-279`) | — | 🟡 PARCIAL |
| `VendaCancelamentoService.cancelarVendaPut` | Cancelar venda | `vendas` UPDATE, `vendas_canceladas` | Não da venda | **Não** | Estoque COMPAT | 🔴 RISCO |
| `VendaCancelamentoService` (estorno) | Estorno cancelamento | `financeiro` INSERT | Não | **Não** `:117-121` | — | 🔴 RISCO |
| `VendaFinanceiroService.executarCancelamentoFinanceiro` | Cancelar lançamentos | `financeiro` UPDATE | Não | N/A (não filtra empresa) `:107-118` | por `venda_id` | 🔴 RISCO |
| `VendaDevolucaoService.devolverParcial` | Devolução | `vendas_devolucoes` | `req.empresaId` | **Não** | COMPAT estoque | 🔴 RISCO |
| `VendaFinanceiroService.recalcularFinanceiroDevolucaoVenda` | Estorno devolução | `financeiro` | `opcoes.empresaId` | `\|\| null` `:344` | caller não passa | 🔴 RISCO |
| `estoqueSaldosPublico._ajustarSaldo` | Crédito/débito saldo | `produtos` | Sim (`ctx.empresaId`) | N/A (tabela sem coluna) | `modoLegadoSemEmpresa` | 🟡 PARCIAL |
| `estoqueSaldosPublico.espelharEfeitoEmEstoqueEmpresa` | Dual-write saldo | `estoque_empresa` | Sim | Sim (`produto_id+empresa_id`) `:313-315` | só se não-legado | 🟢 SEGURO |
| `EstoqueEmpresaService.aplicarEfeitoSaldo` | Mutar saldo isolado | `estoque_empresa` | Sim obrigatório | Sim | Não | 🟢 SEGURO |
| `EstoqueEmpresaService.aplicarEfeitoReservado` | Mutar reservado isolado | `estoque_empresa` | Sim | Sim `WHERE produto+empresa` | Não | 🟢 SEGURO |
| `reservasPublico._criarReservaTipo` | Reserva pedido | `produtos.reservado_*`, `pedido_estoque_reservas` | Sim nos opts | **Não** no tracking; **não** espelha EE `:354-365` | COMPAT | 🔴 RISCO |
| `reservasPublico.liberarReservasPedido` | Liberar pedido | idem | Contexto opts | Não | sem espelho `:425` | 🔴 RISCO |
| `reservasPublico.ajustarReservado` | Reserva/libera PDV | `produtos` + `estoque_empresa` | Sim | Espelho se não-legado `:519-522` | COMPAT | 🟡 PARCIAL |
| `EstoqueReservaService.reservarItem` | Tracking PDV | `venda_estoque_reservas` | Sim | **Não** | `COMPAT_RESERVA_PDV` | 🟡 PARCIAL |
| `EstoqueConsumoReserva.consumirReservasDaVenda` | Consumir PDV | tracking + porta | Sim | N/A | COMPAT | 🟡 PARCIAL |
| `AtendimentoMultiempresaService.persistirAtendimento` | Atendimento MULTI | `atendimentos`, `atendimento_operacoes` | Sim (item) | Sim NOT NULL | Não | 🟢 SEGURO |
| `AtendimentoMultiempresaService.persistirLinhaReserva` | Reserva MUV | `atendimento_operacao_reservas` | Sim (operação) | Sim NOT NULL | Não | 🟢 SEGURO |
| `consumirReservasOperacao` | Consumo MUV | reservas MUV + porta | Sim `exigirEmpresa: true` | status CONSUMIDA | Não | 🟢 SEGURO |
| `creditarEstoqueItemCompra` | Entrada compra | porta → `produtos`/`estoque_empresa` | Sim (compra) | Dual-write | COMPAT | 🟡 / 🟢 no POST compras MULTI |
| `debitarEstoqueItemVenda` | Baixa venda | porta | Sim | Dual-write | COMPAT | 🟡 PARCIAL |
| `creditarEstoqueItemVenda` | Retorno cancel/dev | porta | Sim (`req`) | Dual-write | `COMPAT_CREDITO_VENDA` | 🟠 COMPAT |
| `debitarEstoqueItemCompra` | Estorno compra | porta | Sim | Dual-write | COMPAT | 🟡 PARCIAL |
| `ajusteEstoqueService.aplicarAjusteEstoqueProduto` | Ajuste | porta + `produtos_ajustes_estoque` | `empresaIdDoReqAjuste` | Histórico **não** | COMPAT | 🟡 PARCIAL |
| `ajusteEstoqueService.aplicarSaldoInicialCreateProduto` | Saldo inicial | porta | Opcional | Dual-write se explícito | COMPAT | 🟡 PARCIAL |
| `lotesService.criarLoteComLoteGerado` | INSERT lote | `produtos_lotes` | **Não** | **Não** | — | 🔴 RISCO |
| `lotesService.consumirLotesFEFO` | Consumo FEFO | `produtos_lotes`, `venda_lotes` | **Não** | **Não** `:148` | por produto | 🔴 RISCO |
| `lotesService.restaurarLotesVenda` | Restaurar lote | `produtos_lotes` | **Não** | **Não** | — | 🔴 RISCO |
| `lotesService.atualizarEstoqueConsolidado` | Recalc `estoque_atual` | `produtos` | **Não** | N/A | **bypass porta** `:355-360` | 🔴 RISCO |
| `MtsService.transferirSaldo` | MTS F↔NF | porta + `movimentos_transferencia_saldos` | Sim ou COMPAT | Auditoria **sem** empresa | COMPAT certificada | 🟡 PARCIAL |
| `rotas/caixa.js executarAberturaCaixa` | Abrir caixa | `caixa`, `caixa_sessoes` | Sim (`resolverEmpresaIdParaCaixa`) | Sim em `caixa_sessoes` `:314-318` | SIMPLES contrato | 🟢 SEGURO |
| `rotas/caixa.js` abertura mov | Mov. abertura | `caixa_movimentacoes` | Indireto (sessão) | **Não** `:327-336` | — | 🟡 PARCIAL |
| `rotas/caixa.js` sangria/suprimento | Mov. caixa | `caixa_movimentacoes` | Sessão + middleware | **Não** | LIMIT 1 se sem empresa | 🟡 / 🔴 se lookup global |
| `rotas/caixa.js` fechar | Fechamento | `caixa_sessoes`, `caixa_fechamentos` | Sim | Filtro UPDATE por empresa | — | 🟢 SEGURO (com contexto) |
| `montarSqlSessaoAberta` (leitura) | Localizar caixa aberto | `caixa_sessoes` | Opcional | N/A | **LIMIT 1 global** `:37-39` | 🔴 RISCO |
| `rotas/caixa.js:117` (leitura) | Turno legado | `caixa` | Não | N/A | LIMIT 1 | 🔴 RISCO |
| `rotas/financeiro.js` INSERT manual | Lançamento ERP | `financeiro` | Sim obrigatório `:189-195` | Sim | Recusa sem empresa | 🟢 SEGURO |
| `rotas/contas_receber.js POST /pagar` | Baixa parcela | `financeiro`, pagamentos | Middleware + `exigirRegistroDaEmpresa` | Sim `:185-198` | — | 🟢 SEGURO |
| `rotas/compras.js continuarGravacao` | INSERT compra | `compras` | `resolverEmpresaDaCompra` | Sim `:1567,1617` | SIMPLES contrato | 🟢 SEGURO |
| `rotas/compras.js continuarItem` | Itens | `compras_itens` | Herda compra | **Não** (sem coluna) | — | 🟡 PARCIAL |
| `rotas/compras.js criarFinanceiroCompra` | AP compra | `financeiro` | Sim obrigatório `:282-284` | Sim | Recusa | 🟢 SEGURO |
| `rotas/compras.js finalizarCancelamento` | Cancelar compra | `compras` UPDATE | Sim | Filtra `AND empresa_id=?` `:2012` | — | 🟢 SEGURO |
| `emissor.salvarNota` | NFC-e | `nfce_notas` | `opcoes.empresaId` | `empresa_id \|\| null` `:181-201` | null no legado | 🟡 PARCIAL |
| `emitirPorVendaId` | Emissão | XML + `nfce_notas` | Opcional `:210-218` | Só se passado | `getFiscalConfig()` GLOBAL | 🔴 no legado / 🟢 no MUV |
| `cancelarNfce` | Evento 110111 | `nfce_notas` UPDATE | **Não** | N/A | `getFiscalConfig()` `:10` | 🔴 RISCO |
| `FiscalizarAtendimentoService.fiscalizarOperacao` | Fiscal MUV | documento MUV + emissor | Sim persistido | Via emissor com `empresaId` | **Bloqueia** global `:283-288` | 🟢 SEGURO |
| `incrementaNumeroFiscal` | Numeração | `nfce_notas` / config | Opcional | — | MAX global | 🟠 COMPAT |
| `CentralDocumentosRepository.inserir` | Inbox Central | `central_entradas_documentos` | Se informado | Sim nullable | null possível | 🟡 PARCIAL |
| `CentralDfePersistenciaService.persistirDocumentoDfe` | DF-e → Central | `central_entradas_documentos` | `dados.empresaId` ou `this._empresaId` | Sim | null | 🟡 PARCIAL |
| `distribuicaoDFe.persistirDocumentosRetorno` | Loop ZIP DF-e | via persistencia | **Bug `deps`** `:323` | Falha no try | catch → ignorados | 🔴 RISCO |
| `CentralComprasBridgeService.vincularCompra` | Vínculo doc↔compra | `central_entradas_documentos` UPDATE | Valida igualdade | Não altera coluna | Recusa divergência | 🟢 SEGURO |
| `MiipDecisoesRepository.inserir` | Decisão MIIP | `miip_decisoes` | **Não** | **Não** | global | 🟡 PARCIAL (catálogo) |
| `MiipAssociacoesRepository.inserir` | Associação fornecedor | `miip_associacoes` | **Não** | **Não** UNIQUE global | — | 🟡 PARCIAL |
| `MiipSinonimosRepository` / `Estatisticas` / `Configuracoes` | Aprendizado | `miip_*` | **Não** | **Não** | — | 🟡 PARCIAL |
| `EstoqueEmpresaBackfillService` | Backfill snapshot | `estoque_empresa` | Sim obrigatório | Sim | Copia `produtos` → **uma** empresa | 🟢 SEGURO (manual) |
| `financeiroEmpresaHelpers.backfillFinanceiro` | Migration 05.38.D | `financeiro`, `contas_receber` | Empresa operacional | UPDATE NULL | blanket NULL em SIMPLES | 🟠 COMPAT |
| `comprasEmpresaHelpers.backfillComprasEmpresaId` | Migration 05.38.F | `compras` | Heurística | UPDATE NULL | única / config | 🟠 COMPAT |
| `centralEntradasEmpresaHelpers.backfillDocumentosCentral` | Migration 05.38.E | `central_entradas_documentos` | CNPJ dest | UPDATE NULL | operacional restante | 🟠 COMPAT |
| `caixaSessaoHelpers.migrarEmpresaIdCaixaSessoes` | Migration 05.38.C | `caixa_sessoes` | Operacional / única | UPDATE NULL | — | 🟠 COMPAT |
| Writers `nfe_notas` (emissão 55) | NF-e venda | `nfe_notas` | Não localizado na coluna | **Não** (schema sem coluna) | — | 🟡 PARCIAL |
| Writers `notas_recebidas*` | Legado DF-e | `notas_recebidas` | — | Sem coluna | **Sem writers ativos** | ⚫ NÃO AUDITADO (obsoleto) |

---

## Núcleo por domínio (quem realmente escreve)

| Domínio | Writer canônico | Writer paralelo / legado |
|---------|-----------------|--------------------------|
| Vendas | W1 `VendaPagamentoService` | W2 materialização MUV · W3 entrega |
| Atendimento MULTI | `AtendimentoMultiempresaService` | — |
| Estoque saldo | Porta `estoqueSaldosPublico` | `lotesService.atualizarEstoqueConsolidado` (bypass) |
| Estoque empresa | `EstoqueEmpresaService` (espelho) | — |
| Reservas pedido | `reservasPublico._criarReservaTipo` | **não** usa `ajustarReservado` |
| Reservas PDV | `EstoqueReservaService` + `ajustarReservado` | — |
| Reservas MUV | `persistirLinhaReserva` | — |
| Financeiro ERP | `rotas/financeiro.js` / contas_receber | Venda legado (com coluna) · MUV/cancel/dev (sem) |
| Caixa | `rotas/caixa.js` sessões | Tabela `caixa` LIMIT 1 |
| Fiscal NFC-e | `emissor.js` | MUV `FiscalizarAtendimentoService` (único sem GLOBAL) |
| Compras | `rotas/compras.js` | — |
| Central | `CentralDocumentosRepository` | `persistirDocumentosRetorno` (bug) |
| MIIP | Repositórios `miip_*` | Sem empresa |

---

## Tabelas que **deveriam** ter ownership empresarial (regra oficial) vs estado real

| Tabela | Deveria? | Tem? |
|--------|----------|------|
| `vendas` | Sim (vendas com ownership) | **Não** |
| `vendas_itens` / pagamentos / recebimentos | Sim (ou herdar venda) | Não |
| `vendas_canceladas` / `vendas_devolucoes` | Sim | Não |
| `financeiro` / `contas_receber` | Sim | Sim (nullable; writers falham em satélites) |
| `caixa_sessoes` | Sim | Sim (nullable) |
| `caixa_movimentacoes` | Sim (ou herdar sessão) | Não |
| `compras` | Sim | Sim |
| `central_entradas_documentos` | Sim | Sim |
| `nfce_notas` / `nfe_notas` | Sim | NFC-e PARCIAL (ALTER); NF-e **Não** |
| `estoque_empresa` | Sim | Sim NOT NULL |
| `produtos_lotes` | Sim se estoque separado por empresa | **Não** |
| Tracking reservas pedido/PDV | Sim para auditoria | **Não** |
| `produtos` | **Não** (catálogo compartilhado) | Não — **correto** |
| `miip_*` | Decisão: catálogo compartilhado sugere global | Não — coerente com regra de produto |
| `fornecedores` | Não especificado na regra oficial | Não |

---

## Writers que **não** recebem empresaId (lista curta)

- `lotesService.*` (todos)
- `cancelarNfce`
- `VendaCancelamentoService` (localização da venda)
- `VendaDevolucaoService` (localização da venda)
- `MaterializarOperacoesAtendimento` INSERT financeiro (recebe mas não usa)
- `Miip*Repository`
- `atualizarEstoqueConsolidado`
- `persistirDocumentosRetorno` (tenta ler `deps` inexistente)
