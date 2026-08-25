# MATRIZ DE OWNERSHIP EMPRESARIAL — Sprint 05.39

**STATUS:** AUDITORIA CONCLUÍDA — SOMENTE LEITURA  
**Data:** 2026-08-24  
**Regra:** nenhuma correção foi implementada. Classificações possuem evidência de arquivo/função/linha.

Legenda:

| Símbolo | Classificação |
|---------|----------------|
| 🟢 | SEGURO — `empresaId` explícito ou ownership inequivocamente garantido no fluxo |
| 🟡 | PARCIAL — trecho seguro, mas há contexto indireto, persistência incompleta ou dual-write |
| 🟠 | DEPENDENTE DE COMPATIBILIDADE — legado, fallback ou mecanismo temporário |
| 🔴 | RISCO CONFIRMADO — operação cruzada, leitura/escrita sem ownership, fallback perigoso ou ausência de filtro |
| ⚫ | NÃO AUDITADO — fluxo não localizado no código |

---

## Schema operacional (fundação da matriz)

| Tabela | `empresa_id` | Evidência |
|--------|--------------|-----------|
| `empresas` | N/A (entidade) | `backend/services/empresas/empresasSchema.js` |
| `usuario_empresas` | SIM NOT NULL | schema separado |
| `estoque_empresa` | SIM NOT NULL | `estoqueEmpresaSchema.js:10-25` |
| `empresas_configuracao_fiscal` | SIM (PK) | `empresasConfiguracaoFiscal.js` |
| `atendimento_operacoes` | SIM NOT NULL | `atendimentoSchema.js:26-39` |
| `atendimento_operacao_reservas` | SIM NOT NULL | `atendimentoSchema.js:42-61` |
| `compras` | SIM nullable | `database.js:1773` + ALTER `:298` |
| `financeiro` | SIM nullable | `database.js:1938` + ALTER `:314` |
| `contas_receber` | SIM nullable | `database.js:1978` + ALTER `:374` |
| `caixa_sessoes` | SIM nullable | `database.js:3134` + ALTER `:160` |
| `central_entradas_documentos` | SIM nullable | `database.js:2206` + ALTER `:2226` |
| `dfe_auditoria` | SIM nullable | `database.js:2316` |
| `nfce_notas` | PARCIAL (ALTER runtime) | CREATE sem coluna `database.js:2117`; `garantirSchemaFiscalEmpresaAsync` `:100` adiciona |
| `vendas` | **NÃO** | `database.js:1838-1858`; ALTERs `:145-437` sem `empresa_id` |
| `vendas_itens` / `venda_pagamentos` / `venda_recebimentos` | NÃO | `database.js:1882`, `:1905`, `:2033` |
| `vendas_canceladas` / `vendas_devolucoes` | NÃO | `database.js:2103`, `:1818` |
| `caixa_movimentacoes` / `caixa` (turno) | NÃO | `database.js:3151`, `:3105` |
| `produtos` | NÃO (catálogo compartilhado — regra oficial) | `database.js:1528` |
| `produtos_lotes` / `venda_lotes` | NÃO | `database.js:1245`, `:1269` |
| `pedido_estoque_reservas` / `venda_estoque_reservas` | NÃO | `database.js:1331`, `:2053` |
| `compras_itens` | NÃO (herda via `compra_id`) | `database.js:1784` |
| `nfe_notas` | NÃO | `database.js:3529-3556` |
| `miip_*` (5 tabelas) | NÃO | `database.js:530-767` |
| `notas_recebidas` / `notas_recebidas_dfe` | NÃO (legado, sem writers ativos) | `database.js:2143-2176` |

**A venda possui ownership empresarial persistido?** **PARCIAL.**  
Evidência: tabela `vendas` sem coluna `empresa_id`; vínculo indireto via `caixa_sessao_id` → `caixa_sessoes.empresa_id` (`database.js:151`, `VendaPagamentoService.js:1069`); no MUV, via `atendimento_operacoes.empresa_id` + `venda_id` (`atendimentoSchema.js:29`, `MaterializarOperacoesAtendimento.js:306-312`).

---

## Matriz

| # | DOMÍNIO | OPERAÇÃO | ENTRY POINT | SERVICE/WRITER | EMPRESA_ID ORIGEM | PROPAGAÇÃO | PERSISTÊNCIA | CLASSIFICAÇÃO | RISCO |
|---|---------|----------|-------------|----------------|-------------------|------------|--------------|---------------|-------|
| 1 | 01 Contexto | Contrato EMPRESA_SIMPLES | `configuracoes.modo_operacional_global` | `ContratoOperacionalService.montarContratoOperacional` `:14-32` / `PoliticaEmpresaSimples.resolverEmpresaOperacional` `:77-110` | Config `empresa_operacional_id` ou única ativa | Explícita no contrato | Config JSON, não em transação | 🟢 SEGURO | Ambíguo N>1 bloqueado (`:105-110`); não usa “primeira de N” |
| 2 | 01 Contexto | Contrato MULTIEMPRESA | idem | `PoliticaMultiempresa.resolverEmpresaOperacionalContrato` `:18-19` | Sempre `null` | Por operação HTTP | Nenhuma no contrato | 🟢 SEGURO | Empresa operacional de contrato não existe neste modo |
| 3 | 01 Contexto | Empresa ativa no cliente | `CdsEmpresaContexto.persistir` | `frontend/shared/js/cds-empresa-contexto.js:10-68` | `localStorage cds_empresa_id` | Header `X-Empresa-Id` | Só cliente; JWT sem claim | 🟡 PARCIAL | Sessão servidor inexistente; estado pode divergir entre abas |
| 4 | 01 Contexto | Auto-seleção 1 empresa | `CdsEmpresaContexto.inicializar` `:178-214` | ERP `core.js:1129-1168` | Primeira (única) da lista `/contexto/disponiveis` | Persiste localStorage | Cliente | 🟠 COMPATIBILIDADE | UX; mascara ausência de seleção consciente |
| 5 | 01 Contexto | Extração HTTP | Qualquer rota com middleware | `empresaContexto.resolverEmpresaIdDaRequisicao` `:90-106` | Header → `req.empresaId` → body → query | Explícita se presente | N/A | 🟡 PARCIAL | Sem JWT; ordem documentada |
| 6 | 01 Contexto | Middleware opcional | `rotas/vendas.js:47` e outras | `criarMiddlewareContextoEmpresa` `:118-131` | Header opcional | `req.empresaId = null` se ausente | N/A | 🟠 COMPATIBILIDADE | Rotas operam sem isolamento em MULTI |
| 7 | 01 Contexto | Middleware obrigatório | `rotas/estoque.js:59` | idem `{ obrigatorio: true }` | Header obrigatório | Bloqueia sem empresa | N/A | 🟢 SEGURO | — |
| 8 | 02 Vendas | Criar venda legado | `POST /api/vendas` | `VendaApplicationService.criarVendaComContexto` `:134-170` → `VendaPagamentoService.criarVenda` `:664` | `resolverEmpresaIdParaFinanceiro` + caixa | Runtime até financeiro/estoque | **Não** em `vendas`; sim em `financeiro`/`contas_receber` (`:1642-1660`) | 🟡 PARCIAL | Ownership da linha de venda ausente |
| 9 | 02 Vendas | Listar vendas | `GET /api/vendas` | `rotas/vendas.js:50-134` | `req.empresaId` **não usado** no WHERE | Nenhuma | N/A | 🔴 RISCO CONFIRMADO | Leitura cruzada de todas as empresas |
| 10 | 03 PDV Universal | Contexto operacional | `GET /pdv-universal/contexto` | `PDVUniversalContextService.obterContextoOperacional` `:172-224` | Header / única disponível `:97-98` | DTO; **não grava em venda** (comentário `:3-4`) | localStorage | 🟢 SEGURO | Seleção validada; não é ownership da venda |
| 11 | 03 PDV Universal | Selecionar empresa | `PUT /pdv-universal/contexto/empresa` | `selecionarEmpresaOperacional` `:236-281` | Body `empresa_id` explícito | Cliente + header | localStorage | 🟢 SEGURO | — |
| 12 | 03 PDV Universal | Checkout EMPRESA_UNICA | `POST /pdv-universal/checkout` | `PDVUniversalApplicationService` → `EmpresaUnicaAdapter` → `VendaPagamentoService` | Contexto `empresa_selecionada` `:102-104` | `req.empresaId` | Não em `vendas` | 🟡 PARCIAL | Mesmo writer legado |
| 13 | 03 PDV Universal | Checkout MULTIEMPRESA | idem | `AtendimentoMultiempresaService.criarAtendimento` | `itens[].empresaId` obrigatório (`contratos.js:464-493`) | Agrupa por empresa | `atendimento_operacoes.empresa_id NOT NULL` | 🟢 SEGURO | Header não define a operação |
| 14 | 04 PDV Express | Finalizar venda | `frontend/pdv/js/pdv.js` `enviarVenda` `:5088-5100` | `POST /api/vendas` → W1 legado | Header opcional `CdsEmpresaContexto` | Sem `empresaId` nos itens | Não em `vendas` | 🟠 COMPATIBILIDADE | Não é o pipeline MUV; projetado para EMPRESA_UNICA |
| 15 | 05 MUV | Criar atendimento | `POST /api/vendas` (modo MULTI) ou checkout MULTI | `AtendimentoMultiempresaService.criarAtendimento` `:282` | Item explícito | Persistida por operação | `atendimento_operacoes.empresa_id` | 🟢 SEGURO | — |
| 16 | 05 MUV | Reservar | `POST .../reservar` | `reservarAtendimento` `:491+` | Operação persistida | Dual-write porta + tracking MUV | `atendimento_operacao_reservas.empresa_id` | 🟢 SEGURO | — |
| 17 | 05 MUV | Pagar | `POST .../pagamento` | `confirmarPagamentoAtendimento` `:1061+` | Rateio por `empresa_id` da operação | Explícita | Rateios com empresa | 🟢 SEGURO | — |
| 18 | 05 MUV | Fiscalizar | `POST .../fiscalizar` | `FiscalizarAtendimentoService.fiscalizarOperacao` `:190-292` | `operacao.empresaId` persistido | Bloqueia fallback global `:282-288` | `nfce_notas.empresa_id` se emissor receber `empresaId` | 🟢 SEGURO | Único caminho fiscal que **proíbe** config global |
| 19 | 06 Materialização | Persistir venda MUV | `POST .../materializar` | `persistirVendaOperacao` `:163-234` | `operacao.empresaId` `:164` | Valida item vs operação `:188-193` | **Não** em `vendas` | 🟡 PARCIAL | Vínculo só em `atendimento_operacoes.venda_id` |
| 20 | 06 Materialização | INSERT financeiro MUV | idem | `MaterializarOperacoesAtendimento.js:226-231` | Disponível em memória, **não gravado** | Perdida no INSERT | `financeiro` **sem** `empresa_id` | 🔴 RISCO CONFIRMADO | Escrita financeira sem ownership |
| 21 | 06 Materialização | Consumir reservas | idem | `consumirReservasOperacao` `:237-284` | `operacao.empresaId` + `reserva.empresaId` | `exigirEmpresa: true` `:265-266` | Estoque via porta | 🟢 SEGURO | Divergência reserva×operação lança 500 |
| 22 | 07 Estoque | Crédito compra | `POST /compras` | `creditarEstoqueItemCompra` / porta | `compra.empresa_id` / `req.empresaId` | Dual-write se não-legado | `estoque_empresa` + `produtos` | 🟡 PARCIAL | COMPAT grava só `produtos` |
| 23 | 07 Estoque | Débito venda | `criarVenda` / materializar | `debitarEstoqueItemVenda` | `req.empresaId` ou operação MUV | Porta + dual-write | `estoque_empresa` se explícito | 🟡 PARCIAL | COMPAT `COMPAT_DEBITO_VENDA` |
| 24 | 07 Estoque | Dual-write saldo | Porta pública | `estoqueSaldosPublico._ajustarSaldo` `:302-315` | `ctx.empresaId` | Espelho se `legado !== true` | `estoque_empresa` WHERE produto+empresa | 🟢 SEGURO | Caminho isolado **quando** empresa explícita |
| 25 | 07 Estoque | Modo legado sem empresa | Qualquer porta COMPAT | `empresaContexto` / `montarOptsPorta*` | Ausente | `modoLegadoSemEmpresa: true` | Só `produtos` (global) | 🟠 COMPATIBILIDADE | Saldo global compartilhado em MULTI |
| 26 | 07 Estoque | Ajuste manual | `rotas/produtos` / estoque | `ajusteEstoqueService.aplicarAjusteEstoqueProduto` | `empresaIdDoReqAjuste(req)` | Porta | Histórico `produtos_ajustes_estoque` **sem** empresa | 🟡 PARCIAL | Auditoria sem ownership |
| 27 | 07 Estoque | UPDATE `produtos` saldo | Porta (sempre) | `_ajustarSaldo` `:304-310` | Independente | Writer primário global | `UPDATE produtos WHERE id=?` | 🟡 PARCIAL | Storage oficial ainda é `produtos`; dual-write mitiga leitura MULTI |
| 28 | 08 Reservas | Criar reserva de pedido | Motor comercial | `reservasPublico._criarReservaTipo` `:354-365` | `opts.empresaId` | **Não** chama `espelharReservadoEmEstoqueEmpresa` | Tracking **sem** `empresa_id` | 🔴 RISCO CONFIRMADO | `reservado_*` só em `produtos`; `estoque_empresa.reservado_*` defasado |
| 29 | 08 Reservas | Consultar reserva pedido | Pedido | `consultarDisponibilidadeParaPedido` / `SELECT pedido_estoque_reservas` | Disponibilidade usa empresa; tracking **não** | Tracking por `pedido_id` | Sem coluna | 🟡 PARCIAL | Isolamento depende do pedido ser empresarial |
| 30 | 08 Reservas | Liberar reserva pedido | Cancelar pedido | `liberarReservasPedido` `:410-425` | Contexto opts | `_aplicarDeltaReservado` direto, sem espelho | Tracking sem empresa | 🔴 RISCO CONFIRMADO | Mesmo gap do criar |
| 31 | 08 Reservas | Reserva PDV | Entrega / PDV | `EstoqueReservaService.reservarItem` | `req.empresaId` | Dual-write via `ajustarReservado` `:519-522` | `venda_estoque_reservas` **sem** empresa | 🟡 PARCIAL | Efeito isolado OK; tracking sem ownership |
| 32 | 08 Reservas | Reserva MUV | `reservarAtendimento` | `persistirLinhaReserva` | Operação | Dual-write + coluna | `atendimento_operacao_reservas.empresa_id` | 🟢 SEGURO | Melhor modelo do repositório |
| 33 | 08 Reservas | Expirar reserva | — | **Não existe** job/status `EXPIRADA` | — | — | — | ⚫ NÃO AUDITADO | Fluxo inexistente; reservas ATIVA persistem até cancelar/consumir |
| 34 | 09 Consumo | Consumo PDV | Finalizar venda | `EstoqueConsumoReserva.consumirReservasDaVenda` | `opcoes.empresaId` | Porta `liberarQuantidadeReservada` | Tracking por `venda_id` | 🟡 PARCIAL | Baixa física + lotes globais |
| 35 | 09 Consumo | Consumo MUV | Materializar | `consumirReservasOperacao` | `reserva.empresaId` | `exigirEmpresa: true` | Status CONSUMIDA | 🟢 SEGURO | — |
| 36 | 09 Consumo | Ponte pedido→venda | Converter pedido | `pedidoReservaPonteNucleo` | Contexto HTTP | Porta | Tracking pedido | 🟡 PARCIAL | — |
| 37 | 10 Financeiro | Rotas ERP | `/api/financeiro`, `/contas-receber` | `middlewareResolverEmpresaFinanceiro` + `exigirRegistroDaEmpresa` | Contrato ou header | Filtro `empresa_id` | Coluna presente | 🟢 SEGURO | Isolamento das rotas 05.38.D confirmado em testes |
| 38 | 10 Financeiro | Receita da venda à vista | `criarVenda` | `VendaPagamentoService` `:1642-1660` | `req.empresaId \|\| null` | Explícita se resolução ok | `financeiro.empresa_id` | 🟡 PARCIAL | `\|\| null` permite NULL |
| 39 | 10 Financeiro | Contas a receber | `criarVenda` prazo | `:1247-1249` | `req.empresaId \|\| null` | Explícita | `contas_receber.empresa_id` | 🟡 PARCIAL | Idem |
| 40 | 10 Financeiro | Estorno cancelamento | `cancelarVendaPut` | `VendaCancelamentoService.js:117-121` | **Ausente no INSERT** | Nenhuma | `financeiro` sem `empresa_id` | 🔴 RISCO CONFIRMADO | Escrita sem ownership; UPDATE financeiro por `venda_id` sem filtro empresa (`VendaFinanceiroService.js:107-118`) |
| 41 | 10 Financeiro | Estorno devolução | `devolverParcial` | `recalcularFinanceiroDevolucaoVenda` `:344` | `opcoes.empresaId \|\| null` | Caller **não passa** empresa (`VendaDevolucaoService.js:366-368`) | NULL | 🔴 RISCO CONFIRMADO | Estorno financeiro órfão |
| 42 | 11 Caixa | Abertura | `POST /caixa/abrir` | `rotas/caixa.js:314-318` | `resolverEmpresaIdParaCaixa` `:55-76` | Explícita | `caixa_sessoes.empresa_id` | 🟢 SEGURO | MULTI exige header |
| 43 | 11 Caixa | Validar sessão×empresa | Venda PDV / sangria | `exigirSessaoDaEmpresa` `:112-138` + `validarCaixaAberto.js:72-82` | `req.empresaId` | Compara `sessao.empresa_id` | Sessão | 🟢 SEGURO | **Somente se** `empresaId` já está no request |
| 44 | 11 Caixa | Lookup sessão sem empresa | `montarSqlSessaoAberta` | `caixaSessaoHelpers.js:37-39` | Ausente | `ORDER BY id DESC LIMIT 1` **global** | — | 🔴 RISCO CONFIRMADO | Pode abrir/usar sessão da outra empresa |
| 45 | 11 Caixa | Turno legado `caixa` | `rotas/caixa.js:117-121` | `SELECT * FROM caixa WHERE status='aberto' ORDER BY id DESC LIMIT 1` | Ausente | LIMIT 1 global | Tabela `caixa` sem `empresa_id` | 🔴 RISCO CONFIRMADO | Caixa legado não isolado |
| 46 | 11 Caixa | Herança empresa da sessão | `validarCaixaAberto` | `:114-116` | `sessao.empresa_id` se `req.empresaId == null` | Implícita | Preenche `req.empresaId` | 🟠 COMPATIBILIDADE | Venda herda empresa do caixa, não do header |
| 47 | 11 Caixa | Movimentação (sangria/suprimento) | `POST /sangria` `/suprimento` | `rotas/caixa.js` | Sessão (indireto) | Filtro sessão quando contexto presente | `caixa_movimentacoes` **sem** coluna | 🟡 PARCIAL | Ownership via `sessao_id` |
| 48 | 11 Caixa | Caixa ativo = empresa da venda? | Venda PDV | Cadeia `caixa_sessao_id` | Indireta | Não persistida na venda | **PARCIAL** | 🟡 PARCIAL | Ver resposta obrigatória abaixo |
| 49 | 12 Fiscal | Config por empresa | Gestão empresas | `carregarConfiguracaoFiscalEmpresa` | `empresaId` explícito | Certificado/CSC/URLs da linha | `empresas_configuracao_fiscal` | 🟢 SEGURO | Infra pronta |
| 50 | 12 Fiscal | Config global | `getFiscalConfig()` sem args | `configService.js:98-198` | Nenhuma | `fonte: 'GLOBAL'` | `configuracoes` KV | 🟠 COMPATIBILIDADE | Certificado/CSC globais |
| 51 | 13 NFC-e | Emissão pós-venda legado | `VendaFiscalService.responderVendaComFiscal` `:211` | `emitirPorVendaId(vendaId)` **sem** `empresaId` | Ausente | Config GLOBAL | `nfce_notas.empresa_id` NULL | 🔴 RISCO CONFIRMADO | Empresa A pode emitir com certificado/CSC da config global (outra empresa) |
| 52 | 13 NFC-e | Emissão rota manual | `POST /fiscal/emitir/venda/:vendaId` | `rotas/fiscal.js:261-264` | Ausente | GLOBAL | NULL | 🔴 RISCO CONFIRMADO | Idem |
| 53 | 13 NFC-e | Emissão MUV | `fiscalizarOperacao` | `emitir(vendaId, { empresaId, db })` `:292` | Operação persistida | Sem fallback `:283-288` | `empresa_id` na nota | 🟢 SEGURO | — |
| 54 | 13 NFC-e | Numeração sem empresa | `incrementaNumeroFiscal` | `configService.js:357-380` | Opcional | MAX global + `fiscal_numero_atual` | Colisão potencial MULTI | 🟠 COMPATIBILIDADE | Numeração compartilhada no caminho legado |
| 55 | 13 NFC-e | Persistência nota | `emissor.salvarNota` `:181-201` | `opcoes.empresaId \|\| null` | Só se caller passar | Coluna runtime | 🟡 PARCIAL | Caminho legado grava NULL |
| 56 | 14 Cancelamento | Operacional | `POST/PUT /vendas/cancelar/:id` | `VendaCancelamentoService.cancelarVendaPut` `:51-52` | `SELECT vendas WHERE id=?` **sem empresa** | Estoque via `req.empresaId` ou COMPAT | `vendas_canceladas` sem empresa | 🔴 RISCO CONFIRMADO | Empresa do cancelamento **não** é obrigatoriamente a da venda |
| 57 | 14 Cancelamento | Fiscal NFC-e | `cancelarNfceAutorizadaVenda` | `cancelarNfce.js:9-10` `getFiscalConfig()` | Ausente | Certificado/CNPJ **global** | UPDATE `nfce_notas` por `venda_id` | 🔴 RISCO CONFIRMADO | Cancela com credencial da config global, não da nota/empresa |
| 58 | 15 Devolução | Parcial | `POST /vendas/:id/devolver` | `VendaDevolucaoService.devolverParcial` `:217-253` | `SELECT vendas WHERE id=?` | Estoque `req.empresaId` / COMPAT | `vendas_devolucoes` sem empresa | 🔴 RISCO CONFIRMADO | Crédito de estoque pode ir para empresa do contexto atual |
| 59 | 16 Produtos | Catálogo | Cadastro / listagem | `produtos` | N/A (regra oficial: compartilhado) | — | Sem `empresa_id` **por desenho** | 🟢 SEGURO | Não é erro de ownership |
| 60 | 16 Produtos | Overlay estoque na listagem | `GET /produtos` | `leituraEstoqueEmpresaProduto` | Header/contexto | Join `estoque_empresa` | Cadastro global + saldo isolado | 🟡 PARCIAL | Confusão operacional se COMPAT misturar fontes |
| 61 | 17 Saldo inicial | CREATE produto | `rotas/produtos.js:2378-2383` | `aplicarSaldoInicialCreateProduto` | `empresaIdDoReqAjuste(req)` opcional | Porta | `estoque_empresa` se explícito; lote sem empresa | 🟡 PARCIAL | Localização (depósito) inexistente |
| 62 | 18 Lotes | Consumo FEFO | Baixa venda | `lotesService.consumirLotesFEFO` `:121-148` | **Nenhuma** | `SELECT/UPDATE produtos_lotes WHERE produto_id` | Sem `empresa_id` | 🔴 RISCO CONFIRMADO | Empresa A consome lote compartilhado da B |
| 63 | 18 Lotes | INSERT lote | Compra / saldo inicial | `criarLoteComLoteGerado` `:72-88` | Nenhuma | — | Sem `empresa_id` | 🔴 RISCO CONFIRMADO | Pool global por SKU |
| 64 | 18 Lotes | Restaurar devolução | Devolução venda | `restaurarLotesVenda` / `VendaDevolucaoService.js:117-138` | Nenhuma | `WHERE id=?` do lote | Sem empresa | 🔴 RISCO CONFIRMADO | Restaura no pool global |
| 65 | 18 Lotes | Consolidar `estoque_atual` | Validade | `atualizarEstoqueConsolidado` `:355-360` | Nenhuma | Bypass da porta | `UPDATE produtos SET estoque_atual` | 🔴 RISCO CONFIRMADO | Writer fora da porta pública |
| 66 | 19 Compras | INSERT compra | `POST /compras` | `rotas/compras.js:1556-1617` | `resolverEmpresaDaCompra` | Explícita | `compras.empresa_id` | 🟢 SEGURO | — |
| 67 | 19 Compras | Crédito estoque | `processarItensCompra` | `creditarEstoqueItemCompra` + `exigirEmpresa` MULTI | `empresaCompraId` | Explícita | `estoque_empresa` | 🟢 SEGURO | Caminho principal MULTI |
| 68 | 19 Compras | Financeiro da compra | `criarFinanceiroCompra` `:282-326` | Obrigatório | Explícita | `financeiro.empresa_id` | 🟢 SEGURO | — |
| 69 | 19 Compras | Listagem / GET / cancelar | `rotas/compras.js:1274-1900` | `exigirCompraDaEmpresa` | Header/contrato | Filtro `empresa_id` | 🟢 SEGURO | — |
| 70 | 19 Compras | Unicidade chave NF | `SELECT WHERE chave_acesso=?` `:1828` | Global | Sem `empresa_id` | Bloqueia mesma chave entre empresas | 🟡 PARCIAL | Conflito operacional, não corrupção de estoque |
| 71 | 20 Central | Sync DF-e por alvo | `POST /central-entradas/sincronizar` | `listarAlvosSincronizacaoCentral` + `_sincronizarEmpresa` | Plano por empresa | `CentralDfePersistenciaService({ empresaId })` | `central_entradas_documentos.empresa_id` | 🟢 SEGURO | Orquestração MULTI correta |
| 72 | 20 Central | Upload XML | `POST /upload` | `CentralUploadService.processarArquivo` `:123-157` | CNPJ destinatário / SIMPLES | Rota **não** passa `req` | Documento | 🟡 PARCIAL | Depende do XML, não do header |
| 73 | 20 Central | Listagem | `GET /` `:625-631` | `listarDocumentos` | Filtro **opcional** (`req.empresaId` se houver) | Sem filtro = consolidado | 🟡 PARCIAL | Visão cruzada se header ausente |
| 74 | 20 Central | GET/processar por ID | `GET /:id` `:1007`; `POST /:id/processar` `:695` | `obterDocumentoDetalhe` / `processarDocumento` | **Nenhuma** checagem vs JWT/header | Por ID sequencial | Documento tem coluna, rota ignora | 🔴 RISCO CONFIRMADO | Operador da empresa A lê/processa documento da B |
| 75 | 20 Central | Abrir compra / revisar | `POST /:id/abrir-compra` `:946`; `revisar/concluir` `:922` | Bridge | ID sem ownership HTTP | Payload inclui `empresaId` do **documento** | 🔴 RISCO CONFIRMADO | Ação sobre documento de outra empresa se ID conhecido |
| 76 | 21 MIIP | Associação/decisão | Parser Central | `MiipService.processarImportacaoXml` | **Não recebe empresa** (`MiipContext.js:31-36`) | Global UNIQUE `(cnpj_fornecedor, codigo)` | `miip_*` sem coluna | 🟡 PARCIAL | Catálogo compartilhado (regra oficial); aprendizado não rastreia empresa professora |
| 77 | 22 SEFAZ/DF-e | Persistência retorno DistDFe | `persistirDocumentosRetorno` | `distribuicaoDFe.js:211-326` | `deps.contextoCentral` **mas `deps` não existe** | `ReferenceError` → catch → `ignorados++` | Documento pode não ser gravado | 🔴 RISCO CONFIRMADO | Bug: `empresaId` da ingestão DF-e não é aplicado de forma confiável |
| 78 | 22 SEFAZ/DF-e | Consulta por chave | `consultarNotaPorChave` `:767` | `CentralDfePersistenciaService()` **sem** `empresaId` | Ausente + config fiscal global | 🟡 PARCIAL | Persistência sem contexto empresarial |
| 79 | 22 SEFAZ/DF-e | NSU | Sync | `central_entradas_nsu` por `(cnpj, ambiente)` | CNPJ do alvo | Isolado por CNPJ | 🟢 SEGURO | — |
| 80 | 22 SEFAZ/DF-e | Auditoria DF-e | Persistência | `dfe_auditoria.empresa_id` | Contexto sync | Coluna nullable | 🟡 PARCIAL | Depende do caller |

---

## Totais da matriz

| Classificação | Quantidade de operações |
|---------------|-------------------------|
| 🟢 SEGURO | 26 |
| 🟡 PARCIAL | 26 |
| 🟠 COMPATIBILIDADE | 7 |
| 🔴 RISCO CONFIRMADO | 20 |
| ⚫ NÃO AUDITADO | 1 |
| **Total** | **80** |

Domínios obrigatórios investigados: **22 de 22**.

---

## Respostas obrigatórias (caixa / cancelamento / venda)

### A venda possui ownership empresarial persistido?

**PARCIAL.**

- `CREATE TABLE vendas` sem `empresa_id` — `backend/database.js:1838-1858`.
- Nenhum `ALTER TABLE vendas ADD COLUMN empresa_id`.
- Writers `VendaPagamentoService.js:1069`, `MaterializarOperacoesAtendimento.js:177-181` não gravam empresa.
- Satélites: `financeiro.empresa_id` e `contas_receber.empresa_id` no caminho legado; **ausentes** no INSERT MUV e no estorno de cancelamento.
- MUV: ownership na operação (`atendimento_operacoes.empresa_id NOT NULL`), não na venda.

### O caixa ativo pertence inequivocamente à empresa da venda?

**PARCIAL.**

- Abertura grava `caixa_sessoes.empresa_id` — `rotas/caixa.js:314-318`.
- Com `X-Empresa-Id`, `exigirSessaoDaEmpresa` bloqueia divergência — `CaixaEmpresaContextoService.js:112-138`.
- `vendas` não persiste `empresa_id`; vínculo é `caixa_sessao_id`.
- Sem `empresaId`, `montarSqlSessaoAberta` usa `LIMIT 1` global — `caixaSessaoHelpers.js:37-39`.
- `validarCaixaAberto.js:114-116` pode **injetar** `req.empresaId` a partir da sessão (herança, não prova).

### A empresa do cancelamento é obrigatoriamente a mesma da venda original?

**NÃO.**

- Busca `SELECT * FROM vendas WHERE id = ?` — `VendaCancelamentoService.js:52`.
- Nenhuma comparação de empresa.
- Estoque: `montarOpcoesRetornoEstoqueVenda(req)` usa `req.empresaId` — `creditoEstoqueVendaViaPorta.js:40-46`.
- Sem empresa: `modoLegadoSemEmpresa` — `:70-75`.
- UI PDV/ERP de cancelamento não envia `X-Empresa-Id` de forma obrigatória (`frontend/pdv/js/vendas.js:348-357`).

### Devolução pode retornar estoque para empresa diferente?

**SIM — risco confirmado.** Mesmo padrão: venda sem `empresa_id`; crédito via contexto HTTP atual; `vendas_devolucoes` sem coluna; financeiro estorno com `empresa_id` NULL.
