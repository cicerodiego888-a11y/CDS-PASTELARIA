# MAPA DE FLUXOS REAIS — Sprint 05.39

**STATUS:** AUDITORIA CONCLUÍDA — SOMENTE LEITURA  
**Data:** 2026-08-24  
**Código de produção:** não alterado.

Dois caminhos de venda existem de fato. Não são o mesmo fluxo.

```
CAMINHO LEGADO (EMPRESA_UNICA / PDV Express / checkout Universal EU)
  POST /api/vendas  →  VendaPagamentoService.criarVenda  →  INSERT vendas (sem empresa_id)

CAMINHO NOVO (MULTIEMPRESA / MUV)
  checkout MULTI  →  AtendimentoMultiempresaService  →  reserva → pagamento
                 →  MaterializarOperacoesAtendimento  →  INSERT vendas (sem empresa_id)
                 →  atendimento_operacoes.empresa_id NOT NULL (ownership real)
```

---

### 01. CONTEXTO EMPRESARIAL

UI (ERP seletor / PDV Universal seletor)
↓
arquivo: `frontend/shared/js/cds-empresa-contexto.js`  
função: `persistir` / `lerEmpresaId` / `anexarHeaderXhr` (`:10-11`, `:62-68`)
↓
persistência cliente: `localStorage.cds_empresa_id` (não JWT, não session server)
↓
endpoint: `POST /api/empresas/contexto` · `PUT /api/pdv-universal/contexto/empresa`
↓
controller: `backend/rotas/empresas.js` · `backend/rotas/pdv-universal.js:136-152`
↓
application: `EmpresaService.selecionarEmpresaContexto` `:296-324`  
`PDVUniversalContextService.selecionarEmpresaOperacional` `:236-281`
↓
contrato servidor: `ContratoOperacionalService.montarContratoOperacional` `:14-32`  
SIMPLES → `PoliticaEmpresaSimples.resolverEmpresaOperacional` `:77-110`  
MULTI → `PoliticaMultiempresa` retorna `null` `:18-19`
↓
API inbound: `empresaContexto.resolverEmpresaIdDaRequisicao` `:90-106`  
ordem: `req.empresaId` → header `X-Empresa-Id` → body → query
↓
middleware: `criarMiddlewareContextoEmpresa` `:118-131`  
ausente + opcional → `req.empresaId = null` e segue
↓
tabelas: `empresas`, `usuario_empresas`, `configuracoes.json` (`empresa_operacional_id`)
↓
empresaId: recebido no header; obtido por contrato em SIMPLES; fallback única empresa no cliente (`cds-empresa-contexto.js:203-210`)

Classificação: 🟡 PARCIAL (extração) / 🟠 COMPATIBILIDADE (middleware opcional) / 🟢 SEGURO (contrato)  
Risco: em MULTIEMPRESA, rotas com middleware opcional operam sem isolamento.

---

### 02. VENDAS

UI (ERP / PDV Express / PDV Universal EMPRESA_UNICA)
↓
arquivo: `frontend/pdv/js/pdv.js` `enviarVenda` `:5088` · `frontend/pdv-universal/pdv-universal-checkout.js`
↓
endpoint: `POST /api/vendas` (`backend/rotas/vendas.js:240`)
↓
controller: `rotas/vendas.js` + `criarMiddlewareContextoEmpresa` **opcional** `:47`
↓
application: `VendaApplicationService.criarVendaComContexto` `:134-170`  
bifurca `resolverModoOperacaoVendaAtivo` → EMPRESA_UNICA vs MULTIEMPRESA
↓
service: `VendaPagamentoService.criarVenda` `:664-677`  
antes de persistir: `resolverEmpresaIdParaFinanceiro` (obrigatório para financeiro)
↓
writer: `INSERT INTO vendas` `:1069-1070` / `:1391-1411` — **sem empresa_id**  
`INSERT financeiro` / `contas_receber` **com** `req.empresaId || null`
↓
tabelas: `vendas`, `vendas_itens`, `venda_pagamentos`, `financeiro`, `contas_receber`, `produtos` (saldo)
↓
empresaId: obtido por contexto HTTP + contrato SIMPLES; **não persistido na venda**

Classificação: 🟡 PARCIAL  
Risco: listagem `GET /` `:50-134` sem `WHERE empresa_id` — 🔴 leitura cruzada.

---

### 03. PDV UNIVERSAL

UI
↓
arquivo: `frontend/pdv-universal/pdv-universal.js` `carregarContexto` / `selecionarEmpresaOperacional` `:299-325`
↓
JS: módulos leem `localStorage.getItem('cds_empresa_id')` e montam `X-Empresa-Id`  
(`pdv-universal-checkout.js:81-82`, `pdv-universal-caixa.js:59-62`)
↓
endpoint: `GET /api/pdv-universal/contexto` · `POST /api/pdv-universal/checkout`
↓
controller: `backend/rotas/pdv-universal.js` → `PDVUniversalApplicationService`
↓
application: `finalizarCheckout` (EU) `:90-135` **ou** `finalizarCheckoutMultiempresa` `:72-87`
↓
service: EU → `EmpresaUnicaAdapter` → `VendaApplicationService`  
MULTI → `AtendimentoMultiempresaService` (MUV)
↓
writer: EU = `VendaPagamentoService`; MULTI = materialização posterior
↓
tabelas: EU = `vendas`; MULTI = `atendimentos` + `atendimento_operacoes`
↓
empresaId por etapa:

| Etapa | Status |
|-------|--------|
| Contexto | obtido por contexto (header / UNICA_DISPONIVEL) |
| Seleção | recebido explicitamente (`body.empresa_id`) |
| Carrinho EU | obtido por contexto |
| Carrinho MULTI | recebido explicitamente em `itens[].empresaId` |
| Checkout EU | obtido por contexto e propagado em `req.empresaId` |
| Checkout MULTI | recebido explicitamente (não usa header para definir operação) |
| Reserva/pagamento/fiscal MUV | obtido por contexto persistido da operação |
| Venda materializada | **não localizado** na tabela `vendas` |

Classificação: contexto 🟢 · checkout EU 🟡 · ciclo MUV 🟢 (atendimento) / 🟡 (venda)  
Risco: comentário explícito “Não grava em venda” em `PDVUniversalContextService.js:3-4`.

---

### 04. PDV EXPRESS

Não existe módulo/rota nomeado “PDV Express”. O fluxo real é o **PDV legado** `frontend/pdv`.

UI: `frontend/pdv/js/pdv.js`
↓
arquivo/função: `enviarVenda` `:5088-5100` — `POST ${API_URL}/vendas`
↓
payload: itens **sem** `empresaId` (zero ocorrências de `empresa_id` no arquivo de venda)
↓
header: `CdsEmpresaContexto.anexarHeaderXhr` opcional `:5098-5099`
↓
endpoint: `POST /api/vendas` (mesmo núcleo do §02)
↓
controller: `rotas/vendas.js` — **não** passa por `PDVUniversalApplicationService`
↓
application: `VendaApplicationService` direto
↓
service: `VendaPagamentoService.criarVenda`
↓
writer: INSERT `vendas` sem empresa
↓
estoque / financeiro / caixa / fiscal: mesmo caminho legado
↓
empresaId: header opcional; financeiro exige resolução; itens sem empresa

Divergência vs Universal: sem adapter, sem carrinho por item, sem pipeline MUV. Se o modo global for MULTIEMPRESA, `POST /vendas` entra no MUV e **falha** em `validarItensEntradaAtendimento` (empresaId obrigatório no item).

Classificação: 🟠 COMPATIBILIDADE  
Risco: inadequado como canal MULTI; cancelamento `frontend/pdv/js/vendas.js:348-357` sem `X-Empresa-Id` obrigatório.

---

### 05. MOTOR UNIVERSAL DE VENDAS

UI / API
↓
arquivo: `backend/motores/muv/modoOperacaoVenda.js` `resolverModoOperacaoVendaAtivo` `:45-54`  
derivado do modo operacional global (`compatibilidadeModoVenda.js`) — **não lê body/CNPJ**
↓
endpoint: checkout MULTI / `POST /vendas` em modo MULTIEMPRESA
↓
application: `executarNoModoOperacaoVenda` — MULTI **não** cai em EMPRESA_UNICA (`:57-77`)
↓
service: `AtendimentoMultiempresaService`  
criar `:282` → reservar `:491` → pagar `:1061` → materializar `:1241` → fiscalizar
↓
writer: schema `atendimentoSchema.js` (`empresa_id INTEGER NOT NULL` nas operações/reservas)
↓
tabelas: `atendimentos`, `atendimento_operacoes`, `atendimento_operacao_itens`, `atendimento_operacao_reservas`, `atendimento_pagamentos`, `atendimento_pagamento_rateios`, `atendimento_operacao_documentos`
↓
empresaId: entrada explícita nos itens; persistido; usado em reserva/baixa/fiscal

Cancelamento de atendimento MUV: exclusivo MULTI — `PDVUniversalApplicationService.js:220-225` (não é `VendaCancelamentoService`).

Classificação: 🟢 SEGURO no domínio atendimento  
Risco: materialização gera `vendas` sem `empresa_id` (ver §06).

`ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md` **não foi alterado**.

---

### 06. MATERIALIZAÇÃO DE OPERAÇÕES

UI: `pdv-universal-pos-pagamento.js`
↓
endpoint: `POST /api/pdv-universal/atendimentos/:id/materializar`
↓
controller: `PDVUniversalApplicationService.materializarAtendimentoPdv` `:228-244`
↓
application: `AtendimentoMultiempresaService.materializarAtendimento` `:1241+` (status PAGO, fingerprint)
↓
service/writer: `MaterializarOperacoesAtendimento.materializarOperacao` `:287-323`
↓
writer venda: `persistirVendaOperacao` `:177-181` INSERT vendas **sem empresa_id**
↓
writer financeiro: `:226-231` INSERT financeiro **sem empresa_id**
↓
writer estoque: `consumirReservasOperacao` com `empresaId` + `exigirEmpresa: true` `:265-266`
↓
tabelas: `vendas`, `vendas_itens`, `venda_pagamentos`, `financeiro`, `atendimento_operacoes` (UPDATE `venda_id`)
↓
empresaId: autoridade = `operacao.empresaId` persistido; **perdido** na linha `vendas` e no INSERT `financeiro`

Classificação: 🟡 PARCIAL (venda) / 🔴 RISCO CONFIRMADO (financeiro) / 🟢 SEGURO (estoque)  
Risco: satélite financeiro da venda MUV fica sem ownership.

---

### 07. ESTOQUE

UI (compra, venda, ajuste)
↓
arquivo: porta pública `backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`
↓
endpoint: `/api/compras`, `/api/vendas`, `/api/estoque`, `/api/produtos`
↓
service: `creditoEstoqueCompraViaPorta` / `debitoEstoqueVendaViaPorta` / `creditoEstoqueVendaViaPorta` / `ajusteEstoqueService`
↓
writer: `_ajustarSaldo` `:304-310` **sempre** `UPDATE produtos WHERE id=?`  
se `ctx.empresaId && !legado` → `espelharEfeitoEmEstoqueEmpresa` `:313-315`
↓
tabelas: `produtos` (storage oficial) + `estoque_empresa` (espelho isolado)
↓
empresaId: explícito quando contexto HTTP; fallback `modoLegadoSemEmpresa`

Leitura com empresa: `estoque_empresa`; sem registro → **zero** (não cai em `produtos`) — `estoqueSaldosPublico.js:169-230`.  
Leitura sem empresa: `produtos` COMPAT.

Classificação: 🟢 dual-write com empresa / 🟠 COMPAT sem empresa / 🟡 storage dual  
Risco: COMPAT + UPDATE global em `produtos` afetam saldo legado visível a todos.

---

### 08. RESERVAS DE ESTOQUE

#### Pedido
UI pedido → Motor comercial → `reservasPublico.criarReservaFiscal`  
↓ `_criarReservaTipo` `:354` chama `_aplicarDeltaReservado` **sem** espelho  
↓ INSERT `pedido_estoque_reservas` **sem** `empresa_id` `:362-365`  
empresaId: recebido nos opts; **não persistido** no tracking; **não** usado no dual-write  
Classificação: 🔴

#### PDV / entrega
`EstoqueReservaService.reservarItem` → `ajustarReservado` (dual-write OK)  
INSERT `venda_estoque_reservas` sem empresa `:139-145`  
Classificação: 🟡

#### MUV
`persistirLinhaReserva` com `empresa_id` + dual-write  
Classificação: 🟢

#### Expirar
Não há status `EXPIRADA` nem job.  
Classificação: ⚫ NÃO AUDITADO (fluxo inexistente)

---

### 09. CONSUMO DE RESERVAS

Venda PDV → `EstoqueConsumoReserva.consumirReservasDaVenda` → `liberarQuantidadeReservada` (porta) + `debitarEstoqueItemVenda`  
empresaId: `opcoes.empresaId` / COMPAT  
Classificação: 🟡

MUV materializar → `consumirReservasOperacao` com `reserva.empresaId` e `exigirEmpresa: true`  
Classificação: 🟢

Pedido→venda → `pedidoReservaPonteNucleo`  
Classificação: 🟡

---

### 10. FINANCEIRO

Venda
↓
arquivo: `VendaPagamentoService.criarVenda` `:664`
↓
função: `resolverEmpresaIdParaFinanceiro` (`FinanceiroEmpresaContextoService.js:58-123`)  
prioridade: origem domínio → contrato SIMPLES → header MULTI
↓
endpoint ERP: `backend/rotas/financeiro.js:19` middleware dedicado
↓
writer: INSERT `financeiro` / `contas_receber` com `empresa_id` na venda à vista/prazo
↓
tabelas: `financeiro`, `contas_receber`, `contas_receber_pagamentos`
↓
empresaId: explícito nas rotas ERP (🟢); `|| null` na venda (🟡); **ausente** no estorno cancelamento (🔴) e no INSERT MUV (🔴)

Classificação: 🟡 fluxo completo · rotas ERP 🟢  
Risco: writers satélites sem coluna preenchida.

---

### 11. CAIXA

UI: `frontend/erp/js/caixa.js` · `frontend/pdv-universal/pdv-universal-caixa.js` · `frontend/pdv/js/caixa.js`
↓
função: header `X-Empresa-Id` a partir de `cds_empresa_id`
↓
endpoint: `POST /caixa/abrir` · sangria · suprimento · fechar
↓
controller: `rotas/caixa.js` + `middlewareResolverEmpresaCaixa`
↓
service: `CaixaEmpresaContextoService.resolverEmpresaIdParaCaixa` `:55-106`
↓
writer: INSERT `caixa_sessoes` **com** `empresa_id` `:314-318`  
INSERT `caixa_movimentacoes` **sem** coluna `:327-336`
↓
tabelas: `caixa_sessoes`, `caixa_movimentacoes`, `caixa` (turno legado)
↓
empresaId: explícito na abertura; lookup perigoso em `montarSqlSessaoAberta` `:37-39` (LIMIT 1 global)

Classificação: abertura 🟢 · lookup sem contexto 🔴  
Risco: caixa ativo **não** pertence inequivocamente à empresa da venda (PARCIAL — ver matriz).

---

### 12. FISCAL

Venda / gestão
↓
arquivo: `backend/services/fiscal/configService.js` `getFiscalConfig` `:84-198`
↓
função: se `empresaId` → `carregarConfiguracaoFiscalEmpresa` (`fonte: EMPRESA`)  
senão → KV `configuracoes` (`fonte: GLOBAL`, certificado/CSC globais `:187-198`)
↓
tabelas: `empresas_configuracao_fiscal` · `configuracoes`
↓
empresaId: explícito na gestão por empresa (`gestao-empresas-fiscal.js:763`); **não** no fluxo pós-venda legado

Classificação: infra por empresa 🟢 · fallback global 🟠  
Risco: caminho PDV/ERP principal ainda GLOBAL.

---

### 13. NFC-e

Venda (emitir_fiscal)
↓
arquivo: `VendaFiscalService.js:211` → `emitirPorVendaId(payload.vendaId)` **sem empresaId**
↓
emissor: `emissor.js:210-218` `normalizarEmpresaId(opcoes.empresaId)` → null no legado
↓
writer: `salvarNota` com `empresa_id: empresaId || null` `:181-201`
↓
tabelas: `nfce_notas` (coluna adicionada em runtime `empresasConfiguracaoFiscal.js:100`)
↓
empresaId: não localizado no caminho legado; recebido explicitamente no MUV (`FiscalizarAtendimentoService.js:292`)

Numeração: `incrementaNumeroFiscal` sem empresa = MAX global (`configService.js:357-380`).

Classificação: legado 🔴 · MUV 🟢  
Risco: certificado/CSC/URLs da instalação, não da empresa da venda.

`nfe_notas` (modelo 55): CREATE sem `empresa_id` (`database.js:3529-3556`) — 🟡 PARCIAL / não isolado.

---

### 14. CANCELAMENTO

UI: `frontend/pdv/js/vendas.js` · `frontend/erp/js/vendas.js`
↓
endpoint: `POST /vendas/cancelar/:id` (`rotas/vendas.js:254-263`)
↓
controller: `validarCaixaAbertoCancelamentoVenda` — usa `terminal_id` / `caixa_sessao_id` da venda (`:129-148`), **não** `empresa_id`
↓
service: `VendaCancelamentoService.cancelarVendaPut` `:51` — `SELECT * FROM vendas WHERE id = ?`
↓
estoque: `creditoEstoqueVendaViaPorta` com `req.empresaId` ou COMPAT
↓
financeiro: `cancelarFinanceiroVenda` UPDATE por `venda_id` (`VendaFinanceiroService.js:107-118`) + INSERT estorno **sem** `empresa_id` (`:117-121`)
↓
caixa: sessão atual, não validada contra empresa da venda (inexistente na linha)
↓
fiscal: `cancelarNfce(vendaId)` → `getFiscalConfig()` global (`cancelarNfce.js:9-10`)
↓
tabelas: `vendas`, `vendas_canceladas`, `financeiro`, `nfce_notas`, `produtos`/`estoque_empresa`
↓
empresaId: não comparado com a venda original

Classificação: 🔴 RISCO CONFIRMADO  
Risco: empresa do cancelamento **não** é obrigatoriamente a da venda.

---

### 15. DEVOLUÇÃO

UI: `frontend/shared/js/modalDevolucaoVenda.js:152` (Authorization; sem `X-Empresa-Id` obrigatório)
↓
endpoint: `POST /vendas/:id/devolver`
↓
service: `VendaDevolucaoService.devolverParcial` `:239` `SELECT * FROM vendas WHERE id = ?`
↓
writer: INSERT `vendas_devolucoes` sem empresa `:319-323`
↓
estoque: `montarOpcoesRetornoEstoqueVenda(req)` — contexto HTTP atual
↓
lotes: restauração por `produto_lote_id` sem filtro empresa
↓
financeiro: `recalcularFinanceiroDevolucaoVenda` sem passar `empresaId` → NULL `:344`
↓
fiscal: NF-e devolução é caminho à parte (`nfeDevolucaoVenda`) — não revalida empresa da venda original na tabela `vendas`
↓
empresaId: obtido por contexto / fallback; **não** da operação original

Classificação: 🔴 RISCO CONFIRMADO  
Risco: devolução de venda da empresa A pode creditar estoque da empresa B (contexto atual) e/ou `produtos` global.

---

### 16. PRODUTOS

UI cadastro
↓
arquivo: `backend/rotas/produtos.js` · `database.js:1528-1553`
↓
catálogo: compartilhado (sem `empresa_id`) — **conforme regra oficial**
↓
estoque separado: `estoque_empresa` + overlay de listagem (`leituraEstoqueEmpresaProduto`)
↓
preço / estoque_mínimo / atacado: globais em `produtos`
↓
empresaId: N/A no cadastro; operacional no saldo

Classificação: catálogo 🟢 · overlay 🟡  
Risco: não marcar ausência de `empresa_id` em `produtos` como erro. Confusão: saldo global legado vs isolado.

---

### 17. SALDO INICIAL

UI CREATE produto
↓
arquivo: `ajusteEstoqueService.aplicarSaldoInicialCreateProduto` `:391-418`
↓
função chamada: `rotas/produtos.js:2378-2383`
↓
writer: INSERT produto zerado + crédito via porta
↓
lote opcional: origem `ESTOQUE_INICIAL` (`rotas/produtos.js:377-384`) **sem** empresa
↓
tabelas: `produtos`, `estoque_empresa` (se contexto), `produtos_lotes`, `produtos_ajustes_estoque` (sem empresa)
↓
empresaId: `empresaIdDoReqAjuste(req)` opcional; localização/depósito **inexistente** no schema

Classificação: 🟡 PARCIAL

---

### 18. LOTES

UI / baixa automática FEFO
↓
arquivo: `backend/services/lotesService.js`
↓
função: `consumirLotesFEFO` `:121` — `SELECT` por `produto_id` ORDER BY validade; `UPDATE produtos_lotes WHERE id=?` `:148`
↓
writer extra: `atualizarEstoqueConsolidado` `:355-360` UPDATE `produtos.estoque_atual` **bypass porta**
↓
tabelas: `produtos_lotes`, `venda_lotes` — ambas **sem** `empresa_id`
↓
empresaId: **não localizado**

Classificação: 🔴 RISCO CONFIRMADO  
Risco: pool FEFO compartilhado entre empresas do mesmo SKU.

---

### 19. COMPRAS

UI: `frontend/erp/js/compras.js`
↓
endpoint: `POST /api/compras`
↓
controller: `rotas/compras.js:1365` + `resolverEmpresaDaCompra` `:1813-1816`
↓
service: `ComprasEmpresaContextoService.resolverEmpresaDaCompra` `:84-205`  
prioridade: documento Central → HTTP → body → contrato SIMPLES
↓
writer: INSERT `compras` com `empresa_id` `:1567,1617`
↓
estoque: `creditarEstoqueItemCompra` com `empresaId` da compra
↓
financeiro: `criarFinanceiroCompra` exige `empresa_id` `:282-326`
↓
tabelas: `compras` (com), `compras_itens` (sem, herda), `financeiro`, `estoque_empresa`
↓
empresaId: compra ✅ · entrada/estoque ✅ · financeiro ✅ · fornecedor/produto globais (regra de catálogo)

Classificação: gravação principal 🟢 · chave NF global 🟡  
Risco: `SELECT chave_acesso` sem empresa `:1828` bloqueia a mesma NF em outra empresa.

---

### 20. CENTRAL DE ENTRADAS

SEFAZ / upload
↓
arquivo: `CentralEntradasEmpresaContextoService.js` `:66-155`
↓
endpoint: `POST /sincronizar` · `POST /upload` · `GET /` · `GET /:id`
↓
service: `CentralSincronizacaoService._sincronizarEmpresa` injeta `empresaId` na persistência
↓
writer: `CentralDocumentosRepository.inserir` / `CentralDfePersistenciaService.persistirDocumentoDfe`
↓
MIIP: `CentralProcessamentoService` **não** propaga `empresaId` ao motor
↓
bridge: `CentralComprasBridgeService.montarPayloadAbrirCompra` inclui `empresaId`; `vincularCompra` exige mesma empresa
↓
tabelas: `central_entradas_documentos` (com coluna), histórico/eventos sem coluna própria
↓
empresaId: persistido no documento no sync/upload; **rotas por ID não validam** ownership HTTP (`:695`, `:1007`)

Classificação: sync 🟢 · rotas ID 🔴 · listagem 🟡  
Risco: operador autenticado acessa documento de outra empresa por ID.

---

### 21. MIIP

Central parser
↓
arquivo: `enriquecerParseComMiip.js:75-123` → `MiipService.processarImportacaoXml(parsed)`
↓
contexto: `MiipContext.js:31-36` — origem/usuario/sessao — **sem empresa**
↓
writers: `MiipDecisoesRepository` / `MiipAssociacoesRepository` / sinonimos / estatisticas / configuracoes
↓
tabelas: `miip_*` — **nenhuma** com `empresa_id`; UNIQUE global `(fornecedor_cnpj, codigo_fornecedor)`
↓
empresaId: não localizado no motor

Classificação: 🟡 PARCIAL  
Risco: aprendizado compartilhado é **coerente** com catálogo compartilhado; não rastreia qual empresa ensinou. Documento Central continua com `empresa_id`.

---

### 22. SEFAZ / DF-e

Sync
↓
arquivo: `backend/services/fiscal/distribuicaoDFe.js`
↓
função: `persistirDocumentosRetorno` `:211` (xml, persistencia, origem, ctxAudit)
↓
writer: `persistencia.persistirDocumentoDfe` `:319-326`  
tenta `deps.contextoCentral?.empresaId` — **`deps` não é parâmetro**
↓
efeito: `ReferenceError` capturado `:327` → documento contado em `ignorados`
↓
consulta chave: `consultarNotaPorChave` cria persistência **sem** `empresaId`
↓
tabelas: `central_entradas_documentos`, `dfe_auditoria`, `central_entradas_nsu`
↓
empresaId: injeção planejada via `persistencia._empresaId`; **quebrada** no loop de documentos ZIP

Classificação: orquestração MULTI 🟢 · persistência retorno 🔴  
Risco: inbox DF-e não aplica ownership de forma confiável neste ponto.

---

## Padrões perigosos localizados (síntese)

| Padrão | Onde | Papel |
|--------|------|--------|
| `getEmpresaAtiva` / `getEmpresaAtual` | **Não existem** | Equivalentes: `lerEmpresaId`, `resolverEmpresaOperacional`, `req.empresaId` |
| `X-Empresa-Id` | ERP `core.js` + PDV Universal | Canal principal |
| `LIMIT 1` sessão caixa | `caixaSessaoHelpers.js:37-39` | Fallback perigoso |
| `SELECT primeira empresa` | Backfills só se `rows.length === 1` | Seguro (não pega primeira de N) |
| `modoLegadoSemEmpresa` | Portas F×NF | COMPAT estoque/reservas |
| `fonte: GLOBAL` fiscal | `configService.js:187` | Certificado/CSC globais |
| `SELECT * FROM vendas WHERE id=?` | Cancel/devolução | Sem filtro empresa |
