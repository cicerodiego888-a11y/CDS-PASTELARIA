# AUDITORIA FINAL DA FUNDAÇÃO MULTIEMPRESA
## Pós-Implementação 02.7 — CDS Sistemas / Projeto Pastelaria

**Tipo:** auditoria somente leitura  
**Data:** 2026-08-14  
**Escopo:** mutadores de `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`, `reservado_fiscal`, `reservado_nao_fiscal` após as Implementações 02.1–02.7  
**Proibição desta Sprint:** não alterar código, não migrar, não criar empresas, JWT, `estoque_empresa` nem COMPAT

---

## 1. Resumo executivo

Após 02.1–02.7, **os mutadores operacionais principais de saldo estão na porta pública** `estoqueSaldosPublico`:

ajuste, recálculo, crédito de compra, débito de cancelamento/devolução de compra, crédito de cancelamento/devolução de venda, baixa normal de venda.

**Reservas PDV** (criar / liberar / consumir `reservado_*`) estão em `reservasPublico`. **Reservas de Pedido** (criar / liberar via Motor Comercial) também usam a porta. **Consumo Pedido→venda** e **Repair** ainda fazem SQL direto em `reservado_fiscal`.

Storage físico continua em `produtos`. `empresaId` é contrato de contexto, **não isolamento**. Não existe tabela `empresas` operacional de estoque.

**Veredito:**

| Pergunta | Resposta |
|---|---|
| Podemos começar a Fase Empresas (cadastro / CNPJ / contexto)? | **SIM** |
| Apto para `estoque_empresa`? | **AINDA NÃO APTO** |

Motivo: a fundação de escrita operacional está mapeada e centralizada o suficiente para criar o cadastro oficial de empresas. O storage ainda não pode ser substituído enquanto existirem escritores SQL conhecidos fora da porta (NF-e revert, ponte Pedido, Repair, CREATE produto, lotes).

---

## 2. Sprints auditadas

Consideradas **aprovadas** e **não modificadas** nesta auditoria:

| Sprint | Fluxo | Porta | Status testes (2026-08-14) |
|---|---|---|---|
| 02.1 | Ajuste / saldos iniciais (PUT) | `creditarSaldo` / `debitarSaldo` | 15/15 OK |
| 02.2 | Recálculo | `creditarSaldo` / `debitarSaldo` | 15/15 OK |
| 02.3 | Crédito de compra | `creditarSaldo` | 11/11 OK |
| 02.4 | Cancelamento / devolução de compra | `debitarSaldo` | 12/12 OK |
| 02.5 | Cancelamento / devolução de venda | `creditarSaldo` | 12/12 OK |
| 02.6 | Baixa normal de venda | `debitarSaldo` | 12/12 OK |
| 02.7 | Reservas PDV | `reservarQuantidade` / `liberarQuantidadeReservada` | 11/11 OK |

Porta pública (Impl 01): 17/17 OK. MTS: homologado. MUC contrato: 20/20 OK. Motor Comercial RC3.16.1: homologado.

---

## 3. Portas públicas

### 3.1 `estoqueSaldosPublico`

Arquivo: `backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`

| Método | Tipo | Escreve saldo? |
|---|---|---|
| `consultarSaldo` | leitura | não |
| `creditarSaldo` | mutação | sim (via `_ajustarSaldo`) |
| `debitarSaldo` | mutação | sim (via `_ajustarSaldo`) |
| `transferirSaldoEntreTipos` | mutação | sim (via `_ajustarSaldo`) |
| `executarEmTransacao` | infra | não diretamente |

Único `UPDATE produtos` de saldo nesta porta (`_ajustarSaldo`, ~197):

```
SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?
```

Invariante: `estoque_atual = saldo_fiscal + saldo_nao_fiscal`.

### 3.2 `reservasPublico`

Arquivo: `backend/services/fiscalNaoFiscal/reservasPublico.js`

| Método | Tipo | Escreve reserva? |
|---|---|---|
| `consultarDisponibilidade` | leitura | não |
| `consultarDisponibilidadeParaPedido` | leitura | não |
| `criarReservaFiscal` | mutação Pedido | sim |
| `criarReservaNaoFiscal` | mutação Pedido | sim |
| `liberarReservasPedido` | mutação Pedido | sim |
| `reservarQuantidade` | mutação genérica (02.7) | sim |
| `liberarQuantidadeReservada` | mutação genérica (02.7) | sim |
| `ajustarReservado` | fachada | sim |

Único UPDATE de `reservado_*` nesta porta: `_aplicarDeltaReservado` (~412–425). Não altera saldo.

Nenhum método novo foi criado nesta Sprint de auditoria.

---

## 4. Mutadores de saldo

Classificação de cada escrita de `saldo_fiscal` / `saldo_nao_fiscal` / `estoque_atual` encontrada no backend (excluídos testes).

### 4.1 Na porta (esperado)

| Arquivo | Método | Tabela | Campo | Tipo | Origem | Fluxo | EmpresaId? | Usa porta? | SQL direto? | Motor | Risco |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `estoqueSaldosPublico.js` | `_ajustarSaldo` | produtos | SF, SNF, EA | operacional | porta | A–H, O (MTS) | exigido ou COMPAT | sim | sim (interno) | F×NF | BAIXO |

Callers operacionais (não repetem SQL de saldo):

| Arquivo | Método | Categoria | Porta | EmpresaId |
|---|---|---|---|---|
| `ajusteEstoqueService.js` | `aplicarAjusteEstoqueProduto` | G | creditar/debitar | body/user ou COMPAT_AJUSTE |
| `ajusteEstoqueService.js` | `aplicarSaldosIniciaisViaPorta` | G (PUT) | creditar/debitar | body/user ou COMPAT_AJUSTE |
| `estoqueFiscalService.js` | recálculo | H | creditar/debitar | contexto ou COMPAT_RECALCULO |
| `creditoEstoqueCompraViaPorta.js` | `creditarEstoqueItemCompra` | A | creditar | req ou COMPAT_CREDITO_COMPRA |
| `debitoEstoqueCompraViaPorta.js` | `debitarEstoqueItemCompra` | B, C | debitar | req ou COMPAT_DEBITO_COMPRA |
| `creditoEstoqueVendaViaPorta.js` | `creditarEstoqueItemVenda` | E, F | creditar | req ou COMPAT_CREDITO_VENDA |
| `debitoEstoqueVendaViaPorta.js` | `debitarEstoqueItemVenda` | D | debitar | opts ou COMPAT_DEBITO_VENDA |
| `MtsService.js` | `transferirSaldo` | O | transferirSaldoEntreTipos | empresaId ou COMPAT_CERTIFICADA |

`EstoqueConsumoReserva.js` baixa saldo via `reduzirEstoqueDistribuido` → 02.6 (porta). Não é SQL de saldo.

`estoqueNfeDevolucaoVenda.js` `retornarEstoqueNfeDevolucaoVenda` usa `devolverSaldosDistribuidos` → 02.5 (porta).

Importação de quantidades (`quantidadeUpdater.js`) usa `aplicarAjusteEstoqueProduto` → 02.1 (porta).

### 4.2 Fora da porta (SQL direto)

| Arquivo | Método | Tabela | Campo | Tipo | Origem | Fluxo | EmpresaId? | Usa porta? | SQL direto? | Motor | Risco | Classe |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `rotas/produtos.js` | POST criar produto | produtos | SF, SNF, EA | INSERT inicial | cadastro | R / Create | não no INSERT | não | sim | nenhum | MÉDIO | PRECISA REVISAR |
| `rotas/compras.js` | `ensureProductForItem` | produtos | SF=0, SNF=0, EA=0 | INSERT cadastro | compra cria produto | A / Create | não | não (depois credita via porta) | sim | nenhum | BAIXO | PRECISA REVISAR |
| `importacao-inicial-produtos/importer.js` | INSERT produto | produtos | SF=0, SNF=0, EA=0 | INSERT importação | import | P / Create | não | depois ajuste via porta | sim | nenhum | BAIXO | PRECISA REVISAR |
| `lotesService.js` | `atualizarEstoqueConsolidado` | produtos | **somente EA** | sync lotes | validade | R | não | não | sim | nenhum | ALTO | PRECISA REVISAR |
| `estoqueNfeDevolucaoVenda.js` | `reverterEstoqueNfeDevolucaoVenda` | produtos | SF + EA (não SNF) | débito | cancelamento NF-e devolução venda | F (NF-e) | não | não | sim | Motor Fiscal | ALTO | PRECISA MIGRAR |
| `ReleaseCertificationService.js` | etapa estoque | produtos | EA, SF | certificação | homologação | Q | n/a | não | sim | nenhum | BAIXO | FORA DO ESCOPO |
| `CentralInteligenteHomologacaoService.js` | `_criarProdutoComGtin` | produtos | EA=0, SF=0, SNF=0 | INSERT cert | homologação | Q | n/a | não | sim | nenhum | BAIXO | FORA DO ESCOPO |

PUT de produto **não** escreve SF/SNF/EA pelo `UPDATE` genérico: esses campos estão em `CAMPOS_PRODUTO_IGNORADOS`. Saldos iniciais no PUT passam por `aplicarSaldosIniciaisViaPorta`.

`rotas/produtos.js` ~1566 `estoque_atual = ?` atualiza **`promocoes_sugestoes`**, não `produtos`. Não é mutador de estoque.

`rotas/compras.js` ~704 `UPDATE produtos` é metadado (preço/NCM), não saldo (confirmado na 02.3).

Não foram encontrados fluxos operacionais de **inventário, perda ou produção** que escrevam esses campos. Não inventados.

---

## 5. Mutadores de reserva

### 5.1 Na porta

| Arquivo | Método | Campo | Fluxo | EmpresaId? | Classe |
|---|---|---|---|---|---|
| `reservasPublico.js` | `_aplicarDeltaReservado` | RF / RNF | I, J (interno) | exigido ou COMPAT | PRONTO (porta) |
| `EstoqueReservaService.js` | `reservarItem` / `liberarReservasDaVenda` | RF / RNF | I | body/user ou COMPAT_RESERVA_PDV | PRONTO PARA MULTIEMPRESA (contrato) |
| `EstoqueConsumoReserva.js` | `consumirReservasDaVenda` | RF / RNF | I (consumo) | opts da reserva | PRONTO (reserva); saldo via 02.6 |
| `MotorComercialService.js` | criar reserva fiscal | RF | J | portaOpts / COMPAT_CERTIFICADA | PRONTO (criação/liberação) |

### 5.2 Fora da porta (SQL direto)

| Arquivo | Método | Tabela | Campo | Tipo | Origem | Fluxo | EmpresaId? | Usa porta? | SQL direto? | Motor | Risco | Classe |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `pedidoReservaPonteNucleo.js` | `consumirReservasPedidoNaVenda` | produtos | **reservado_fiscal** | consumo Pedido→venda | faturamento / entrega | J | não | não | sim | Comercial (ponte) | ALTO | PRECISA MIGRAR |
| `ReservaRepairService.js` | `handlerLiberarReserva` | produtos | RF | repair liberar | Motor Comercial | K | não | não | sim | Comercial | ALTO | PRECISA MIGRAR |
| `ReservaRepairService.js` | `handlerRemoverReserva` | produtos | RF | repair órfã | Motor Comercial | K | não | não | sim | Comercial | ALTO | PRECISA MIGRAR |
| `ReservaRepairService.js` | `handlerCriarReserva` | produtos | RF | repair criar | Motor Comercial | K | não | não | sim | Comercial | ALTO | PRECISA MIGRAR |
| `ReservaRepairService.js` | `handlerAjustarReserva` | produtos | RF | repair ajustar | Motor Comercial | K | não | não | sim | Comercial | ALTO | PRECISA MIGRAR |

`ReservaReconciliationService.js` **não escreve** `produtos`. Apenas detecta divergência e descreve correção. Escrita ocorre se o plano chamar Repair.

`reservado_nao_fiscal` operacional fora da porta: **não encontrado**. Repair/ponte atuam só em `reservado_fiscal` (modelo Pedido fiscal).

---

## 6. SQL direto restante

Todos os `UPDATE produtos` de saldo/reserva no backend de produção, fora das portas:

| # | Arquivo | SQL | Por quê ainda existe | Legítimo agora? | Ação futura |
|---|---|---|---|---|---|
| 1 | `estoqueNfeDevolucaoVenda.js` `reverterEstoqueNfeDevolucaoVenda` | `SET saldo_fiscal -= q, estoque_atual -= q` | Cancelamento de NF-e de devolução de venda não entrou em 02.5–02.6 | Não como porta; sim como fluxo fiscal legado | Migrar para `debitarSaldo` (e tratar SNF se a devolução original foi mista) |
| 2 | `lotesService.js` `atualizarEstoqueConsolidado` | `SET estoque_atual = somaLotes` | Consolidação de validade/lotes; **não toca SF/SNF** | Controverso: quebra invariante EA=SF+SNF se lotes divergirem | Revisar significado de `estoque_atual` vs lotes |
| 3 | `pedidoReservaPonteNucleo.js` | `SET reservado_fiscal = CASE … - q` | Consumo Pedido após baixa do Núcleo; 02.7 migrou só PDV | Legítimo no desenho atual Pedido; fora da porta | Migrar para `liberarQuantidadeReservada` |
| 4 | `ReservaRepairService.js` (4 handlers) | `SET reservado_fiscal = ?` | Reparação administrativa do Motor Comercial; fora do escopo 02.7 | Legítimo como repair; fora da porta | Migrar para `ajustarReservado` / criar/liberar da porta |
| 5 | `rotas/produtos.js` POST | INSERT SF/SNF/EA | Cadastro cria linha já com saldo | Inicialização real de estoque | Criar com 0 + `aplicarSaldosIniciaisViaPorta` |
| 6 | `rotas/compras.js` INSERT produto | INSERT 0,0,0 | Produto novo na compra | Cadastro, não movimento | Manter 0; crédito segue porta |
| 7 | `importer.js` INSERT | INSERT 0,0,0 | Importação cria produto | Cadastro | Quantidade já vai a ajuste/porta |
| 8 | Certification / Homologação | INSERT/UPDATE de prova | Não é operação de loja | Bootstrap | Fora do escopo operacional |

SQL dinâmico de reserva na porta: `` UPDATE produtos SET ${coluna} = … `` em `_aplicarDeltaReservado` — `coluna` só pode ser `reservado_fiscal` ou `reservado_nao_fiscal`. Classificado como **porta**, não como SQL solto.

Nenhum outro `SET saldo_*` / `SET reservado_*` / `SET estoque_atual` em `produtos` foi encontrado no backend operacional.

---

## 7. Compatibilidades

Nenhuma removida. Todas ainda necessárias enquanto não houver cadastro oficial de empresas + JWT/contexto obrigatório.

| Compatibilidade | Fluxo | Arquivo | Ainda necessária? | Motivo |
|---|---|---|---|---|
| `COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA` | G Ajuste | `ajusteEstoqueService.js` | sim | Ajuste/saldos iniciais sem `empresaId` |
| `COMPAT_RECALCULO_PRE_MULTIEMPRESA` | H Recálculo | `estoqueFiscalService.js` | sim | Recálculo legado |
| `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA` | A Compra | `creditoEstoqueCompraViaPorta.js` | sim | Compra sem empresa no request |
| `COMPAT_DEBITO_COMPRA_PRE_MULTIEMPRESA` | B/C Cancel/dev compra | `debitoEstoqueCompraViaPorta.js` | sim | Idem |
| `COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA` | E/F Cancel/dev venda | `creditoEstoqueVendaViaPorta.js` | sim | Idem |
| `COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA` | D Baixa venda | `debitoEstoqueVendaViaPorta.js` | sim | Idem |
| `COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA` | I Reserva PDV | `EstoqueReservaService.js` | sim | PDV/entrega sem empresa |
| `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` | O/J MTS / Motor Comercial / porta | `empresaContexto.js` | sim | Opt-in explícito; MTS e Pedido certificados |

Não há fallback silencioso para empresa `1` ou CNPJ de `configuracoes`. Ausência de `empresaId` exige COMPAT explícita ou lança `EMPRESA_OBRIGATORIA`.

---

## 8. EmpresaId

`empresaId` **não cria isolamento físico**. Storage = `produtos`.

| Fluxo | Tem empresaId | Fonte | Compatibilidade |
|---|---|---|---|
| Porta saldos | sim (obrigatório) | opts / resolver | COMPAT_CERTIFICADA se legado |
| Porta reservas | sim (obrigatório) | opts / resolver | COMPAT_CERTIFICADA se legado |
| Ajuste | sim quando body/user | `req.body.empresa_id` / `req.user` | COMPAT_AJUSTE |
| Recálculo | sim quando passado | caller | COMPAT_RECALCULO |
| Compra crédito/débito | sim quando req | `req.body` / `req.user` | COMPAT_CREDITO/DEBITO_COMPRA |
| Venda baixa / cancel / dev | sim quando opts | `montarOpcoes*` / `criarVenda` | COMPAT venda |
| Reserva PDV | sim quando caller | entrega / faturamento / PDV | COMPAT_RESERVA_PDV |
| Reserva Pedido (criar) | sim via Motor Comercial | `portaOpts` | COMPAT_CERTIFICADA |
| MTS | sim | `transferirSaldo({ empresaId })` | COMPAT_CERTIFICADA |
| Consumo Pedido (ponte) | **não** | — | — |
| Repair | **não** | — | — |
| NF-e revert estoque | **não** | — | — |
| CREATE produto INSERT | **não** | — | — |
| lotes `estoque_atual` | **não** | — | — |
| VendaContext | campo `empresa` existe | `body.empresa_id` / `body.empresa` | não alimenta porta sozinho |
| JWT / seletor oficial | **não existe** | — | — |
| Tabela `empresas` | **não existe** (checada em `empresaContexto.tabelaEmpresasExiste`) | `dfe_auditoria.empresa_id` é coluna de log | — |

---

## 9. CNPJ

Não há relacionamento CNPJ → estoque. Apenas documentado.

| Domínio | CNPJ disponível? | Onde |
|---|---|---|
| Configuração fiscal / emitente | **sim** | `configuracoes.cnpj`; `config.cnpj` em emissor/xmlBuilder |
| NF-e venda / devolução | **sim** | emitente da config fiscal |
| Compra / fornecedor | **sim** (fornecedor) | XML/MIIP/`compras` (CNPJ do emitente da NF de entrada) |
| Central de Entradas / DistDFe | **sim** | `dfe_auditoria.cnpj`; config emitente |
| Caixa / cupom | **sim** (exibição) | `empresa_cnpj` de `configuracoes` |
| Entrega / body | **opcional** | `body.empresa_cnpj` — não é cadastro |
| Cadastro oficial de empresas | **não** | não existe tabela `empresas` |
| Estoque / `produtos` | **não** | produto global, sem CNPJ |
| Usuário / JWT empresa | **não** | — |

---

## 10. Motores

| Motor | Escreve estoque? | Escreve reserva? | Usa porta? | SQL direto? | Ação futura? |
|---|---|---|---|---|---|
| Motor Fiscal (F×NF saldos) | sim, via porta | não | sim | não (núcleo) | preservar |
| Motor Não Fiscal | sim, via porta | PDV via porta | sim | não (núcleo) | preservar |
| MTS | sim (F↔NF mesmo produto) | **não cria reserva** | `transferirSaldoEntreTipos` | não | preservar; COMPAT até empresas |
| MUC | **não** | **não** | n/a | UPDATE produtos só unidade/embalagem (não saldo) | **não alterar** |
| MIIP | **não** | **não** | n/a | não | **não alterar**; produto continua GLOBAL |
| Central de Entradas | **não** (estoque) | **não** | n/a | não | preservar |
| Motor Comercial | saldo só via MTS/porta; reserva Pedido via porta | criar/liberar porta; **Repair SQL**; ponte consumo SQL | parcial | Repair + ponte | migrar Repair/ponte depois |
| TEF | **não** | **não** | n/a | não | preservar |
| Motor Fiscal NF-e (devolução venda) | retorno via 02.5; **revert SQL** | não | parcial | `reverterEstoqueNfeDevolucaoVenda` | migrar revert |

---

## 11. MTS

Confirmado: MTS permanece **exclusivamente Fiscal ↔ Não Fiscal do mesmo produto**.

- API: `transferirSaldo({ produto, origem, destino, quantidade, … })`
- Mutação: somente `estoqueSaldosPublico.transferirSaldoEntreTipos`
- Não existe transferência Empresa A ↔ Empresa B
- Não cria reservas (comentário oficial em `reservasPublico.js`)

Nenhuma alteração nesta auditoria.

---

## 12. MUC

Confirmado: produto continua **GLOBAL**. MUC converte unidades/apresentações; não possui `empresaId` no cadastro de produto; não escreve saldo/reserva.

Não alterar MUC.

---

## 13. MIIP

Confirmado: identificação de produto (GTIN/código/nome). Não cria produto-por-empresa. Não escreve saldo/reserva.

Não alterar MIIP.

---

## 14. Create Produto

Ponto já identificado na fundação e **ainda fora da porta**.

| Item | Valor |
|---|---|
| Arquivo | `backend/rotas/produtos.js` |
| Método | POST criar produto (~2285) |
| SQL | `INSERT INTO produtos (… estoque_atual, saldo_fiscal, saldo_nao_fiscal …)` |
| Valores | `estoqueInicial`, `saldoFiscalInicial`, `saldoNaoFiscalInicial` (body `saldo_*_inicial` ou legado `estoque_atual`) |
| Finalidade | cadastro com saldo de abertura |
| É realmente estoque? | **Sim** — grava as colunas oficiais de saldo |
| É só teste? | **Não** — caminho de produção do cadastro |
| PUT | **já na porta** (`aplicarSaldosIniciaisViaPorta`) se o produto ainda não vendeu |
| EmpresaId no INSERT | **não** |
| Precisa migrar futuramente? | **Sim** — INSERT com zeros + porta de saldos iniciais. Não nesta Sprint. |
| Classe | PRECISA REVISAR / LEGADO de cadastro |
| Risco | MÉDIO — estoque nasce fora do contrato `empresaId` |

Caminhos correlatos (INSERT com **zero**, depois movimento via porta):

- `compras.js` `ensureProductForItem` — produto criado na compra (SF=0, SNF=0, EA=0)
- `importer.js` — importação inicial (zeros; quantidade via `aplicarAjusteEstoqueProduto`)

---

## 15. Bootstrap

| Origem | Escreve saldo? | Escreve reserva? | Classificação |
|---|---|---|---|
| `database.js` CREATE `produtos` | DEFAULT `estoque_atual=0`; SF/SNF/RF via ALTER DEFAULT 0 | DEFAULT 0 | BOOTSTRAP / LEGADO (schema) |
| `database.js` `dfe_auditoria.empresa_id` | não | não | log DistDFe, não estoque |
| Seeders / scripts | **não encontrados** para saldo/reserva | — | — |
| `migracaoConversaoUnidades.js` | UPDATE flags fracionado, **não saldo** | não | BOOTSTRAP / LEGADO |
| `ReleaseCertificationService.js` | INSERT + UPDATE SF/EA de prova + DELETE | não | BOOTSTRAP / LEGADO |
| `CentralInteligenteHomologacaoService.js` | INSERT produto 0,0,0; depois compra real (porta) | não | BOOTSTRAP |
| Repair | não saldo; **sim reserva** | operacional de correção | OPERACIONAL (fora da porta) |

---

## 16. Duplicidades

Critério: **porta + SQL direto fazendo a mesma alteração no mesmo fluxo**. Isso seria CRÍTICO.

| Hipótese | Resultado |
|---|---|
| Compra credita porta e SQL | **Não.** 02.3 removeu UPDATE de saldo em `compras.js`. Teste 09 da 02.3 cobre. |
| Cancel/dev compra débito duplo | **Não.** 02.4. |
| Cancel/dev venda crédito duplo | **Não.** 02.5. `retornarEstoqueNfeDevolucaoVenda` usa a mesma `devolverSaldosDistribuidos` (porta), não um segundo UPDATE. |
| Baixa venda débito duplo | **Não.** 02.6. Consumo de reserva PDV chama `reduzirEstoqueDistribuido` (porta saldo) **e** `liberarQuantidadeReservada` (porta reserva) — campos **diferentes**, complementar. |
| Reserva PDV dupla | **Não.** 02.7. |
| Faturamento: consumo PDV + consumo Pedido | **Não é o mesmo registro.** `venda_estoque_reservas` vs `pedido_estoque_reservas`. Ambos decrementam `produtos.reservado_fiscal` se existirem reservas nos dois lados. Correto se forem reservas distintas. **REVISÃO NECESSÁRIA** se o mesmo fato físico puder existir nas duas tabelas. Risco: ALTO **condicional**, não comprovado nesta auditoria. |
| NF-e revert vs cancelamento de venda | Fluxos distintos (cancelar NF-e de devolução ≠ cancelar venda). Revert é SQL; retorno é porta. Não é o mesmo evento. |
| lotes vs porta | **Não duplica SF/SNF.** **Pode sobrescrever `estoque_atual`** com soma de lotes, divergindo de SF+SNF. Risco de **invariante**, não de crédito duplo. |

Nenhuma duplicidade comprovada **porta + SQL no mesmo mutador 02.1–02.7**.

---

## 17. Testes

Executados em 2026-08-14 nesta auditoria (`node <arquivo>`). Nenhum código de aplicação foi alterado.

| Suíte | Resultado | Notas |
|---|---|---|
| `ajuste-estoque-porta-publica.test.js` | **15/15 OK** | 02.1 |
| `recalculo-saldos-porta-publica.test.js` | **15/15 OK** | 02.2 · warning pré-existente de dependência circular `recalcularEstoqueConsolidado` |
| `credito-compra-porta-publica.test.js` | **11/11 OK** | 02.3 |
| `debito-cancel-dev-compra-porta-publica.test.js` | **12/12 OK** | 02.4 |
| `credito-cancel-dev-venda-porta-publica.test.js` | **12/12 OK** | 02.5 |
| `debito-baixa-venda-porta-publica.test.js` | **12/12 OK** | 02.6 |
| `reservas-pdv-porta-publica.test.js` | **11/11 OK** | 02.7 |
| `porta-publica-saldos-multiempresa.test.js` | **17/17 OK** | Impl 01 |
| `tests/mts/mts-v1.test.js` | **homologado** | MTS F↔NF |
| `tests/muc/muc-public-contract.test.js` | **20/20 OK** | MUC |
| `tests/faturamento/rc3161-pedido-motor-comercial-mts.test.js` | **homologado** | Motor Comercial + MTS + reserva Pedido |

Falhas pré-existentes conhecidas (não reexecutadas aqui; não são das Sprints 02.x): `hotfix-consumo-exclusivo-motor.test.js` (HOTFIX 4.0.2, `distribuicaoItens`). **Não introduzidas por 02.1–02.7.**

---

## 18. Matriz final

| Fluxo | Saldo | Reserva | Porta | SQL Direto | EmpresaId | Risco | Ação |
|---|---|---|---|---|---|---|---|
| Compra | creditar SF/SNF/EA | — | sim (02.3) | INSERT produto 0,0,0 se novo | req ou COMPAT | BAIXO | Fase Empresas ok; INSERT cadastro revisar |
| Cancelamento compra | debitar | — | sim (02.4) | não | req ou COMPAT | BAIXO | — |
| Devolução compra | debitar | — | sim (02.4) | não | req ou COMPAT | BAIXO | — |
| Venda | debitar | PDV via 02.7 | sim (02.6) | não saldo | opts ou COMPAT | BAIXO | — |
| Cancelamento venda | creditar | — | sim (02.5) | não | opts ou COMPAT | BAIXO | — |
| Devolução venda | creditar (serviço venda + retorno NF-e) | — | sim (02.5) no retorno | **revert NF-e SQL** | não no revert | ALTO no revert | migrar `reverterEstoqueNfeDevolucaoVenda` |
| Ajuste | creditar/debitar | — | sim (02.1) | não | body/user ou COMPAT | BAIXO | — |
| Recálculo | delta via porta | intocado | sim (02.2) | não | contexto ou COMPAT | BAIXO | — |
| Reserva PDV | — | RF/RNF | sim (02.7) | não | caller ou COMPAT | BAIXO | — |
| Reserva Pedido | MTS se lock | criar/liberar porta; **consumo SQL** | parcial | ponte consumo | criar sim / consumo não | ALTO no consumo | migrar ponte |
| Repair | não | RF SQL | não | 4 handlers | não | ALTO | migrar Repair |
| Inventário | — | — | — | **não existe** | — | — | FORA DO ESCOPO |
| Perda | — | — | — | **não existe** | — | — | FORA DO ESCOPO |
| Produção | — | — | — | **não existe** | — | — | FORA DO ESCOPO |
| Transferência | F↔NF mesmo produto | não | MTS → porta | não | sim ou COMPAT | BAIXO | não criar A↔B |
| Importação | INSERT 0 + ajuste porta | — | quantidade sim | INSERT cadastro | ajuste COMPAT | BAIXO | INSERT revisar |
| Bootstrap | schema DEFAULT 0; cert SQL | — | — | certificação | n/a | BAIXO | FORA DO ESCOPO |
| Create Produto | INSERT SF/SNF/EA | 0 | PUT sim; POST não | POST INSERT | não | MÉDIO | migrar POST |

---

## 19. Riscos

1. **Isolamento falso (CRÍTICO conceitual, esperado nesta fase):** `empresaId` no contrato da porta **não** separa estoque. Duas empresas com IDs diferentes leem/escrevem a **mesma** linha de `produtos`.
2. **SQL conhecido fora da porta:** NF-e revert, ponte Pedido, Repair, CREATE, lotes EA.
3. **`lotesService.atualizarEstoqueConsolidado`:** pode setar `estoque_atual` ≠ SF+SNF.
4. **Revert NF-e:** debita só `saldo_fiscal` + `estoque_atual`; não ajusta `saldo_nao_fiscal`; EA não é recalculado como SF+SNF.
5. **COMPAT amplo:** operações reais ainda podem rodar sem empresa.
6. **CREATE produto:** saldo de abertura nasce sem porta e sem empresa.
7. **Repair/ponte:** `reservado_fiscal` ainda pode divergir do caminho PDV (porta) se um repair e um consumo PDV atuarem no mesmo produto sem coordenação — **REVISÃO NECESSÁRIA** no desenho Pedido×PDV, não comprovado como bug atual.
8. Working tree contém **muitas alterações fora de 02.1–02.7** (não desfeitas, não auditadas como mutadores desta Sprint).

---

## 20. Bloqueadores

### Para Fase Empresas (cadastro)

**Nenhum bloqueador técnico obrigatório.** Os SQLs restantes são conhecidos e não impedem criar a tabela/cadastro de empresas.

### Para `estoque_empresa`

Bloqueadores (não implementar agora):

1. Migrar `reverterEstoqueNfeDevolucaoVenda`.
2. Migrar `consumirReservasPedidoNaVenda`.
3. Migrar `ReservaRepairService` (4 handlers).
4. Decidir e migrar POST CREATE produto (INSERT de saldo).
5. Decidir invariante `estoque_atual` vs soma de lotes.
6. Só então substituir storage `produtos` → `estoque_empresa`.

---

## 21. Fase Empresas

**PODEMOS COMEÇAR A FASE EMPRESAS? SIM.**

Riscos que permanecerão conscientemente:

- Sem isolamento físico de estoque
- COMPAT continua necessária
- JWT / seletor ainda não existem
- SQL direto listado na seção 6 continua no ar
- Produto permanece global (MUC/MIIP)
- MTS continua F↔NF, não A↔B
- CNPJ existe na fiscal, ainda sem FK para estoque

Ordem prevista (não executada aqui):

Cadastro de Empresas → CNPJ único → `empresaId` oficial → contexto → seletor / usuário / JWT → compras / vendas / estoque **ainda em `produtos`**.

---

## 22. estoque_empresa

Critérios da Sprint:

| # | Critério | Status |
|---|---|---|
| 1 | Principais mutadores centralizados | **Sim** (A–I operacionais 02.1–02.7) |
| 2 | SQLs restantes conhecidos | **Sim** (seção 6) |
| 3 | Nenhum SQL desconhecido escreve estoque | **Sim** (busca global) |
| 4 | Reservas suficientemente mapeadas | **Sim** (PDV porta; Pedido criar porta; consumo/repair SQL) |
| 5 | EmpresaId preparado | **Contrato sim; isolamento não; cadastro não** |
| 6 | Storage substituível depois | **Ainda não** — escritores SQL restantes quebrariam dual-write |

**AINDA NÃO APTO.**

---

## 23. Recomendação final

1. Iniciar **Fase 2 — Empresas** (cadastro + CNPJ único + contexto). Não criar `estoque_empresa` nessa fase.
2. Manter COMPAT até o contexto empresarial ser obrigatório de verdade.
3. Tratar como fila **pós-cadastro, pré-estoque_empresa**: NF-e revert, ponte Pedido, Repair, CREATE produto, lotes vs EA.
4. Não alterar Motores Fiscal/NF, MTS, MUC, MIIP, Central, TEF nesta fila, salvo o mínimo para passar pela porta.
5. Não remover COMPAT nesta fase.

---

## Anexo A — Working tree (sem limpeza)

Arquivos das Sprints 02.1–02.7 (não desfazer):

- Modificados: `ajusteEstoqueService.js`, `estoqueFiscalService.js`, `estoqueSaldosPublico.js`, `reservasPublico.js`, `index.js` F×NF, `VendaCancelamentoService.js`, `VendaDevolucaoService.js`, `VendaPagamentoService.js`, `EstoqueReservaService.js`, `EstoqueConsumoReserva.js`, rotas compras/produtos (empresaId), entrega/faturamento (02.7)
- Novos: `empresaContexto.js`, adapters `*ViaPorta.js`, docs `IMPLEMENTACAO_02_*`, testes `tests/estoque/*porta-publica*`

O repositório possui **muitas outras** alterações pré-existentes (Central, CIA/CIP, equipamentos, branding, etc.). Fora do escopo desta auditoria. Não limpas.

## Anexo B — Busca global

Termos: `UPDATE produtos`, `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`, `reservado_fiscal`, `reservado_nao_fiscal`, INSERT em `produtos`, SQL dinâmico `${coluna}`.

Cobertura: todo `backend/` (não só arquivos 02.x). Testes isolados em `:memory:` foram ignorados como mutadores de produção.

## Anexo C — REVISÃO NECESSÁRIA (dúvidas não assumidas)

| Item | Arquivo | Método | Comportamento | Dúvida | Risco |
|---|---|---|---|---|---|
| Dupla tabela de reserva no faturamento | `FaturamentoService` + `pedidoReservaPonteNucleo` + `EstoqueConsumoReserva` | consumo PDV e Pedido | ambos podem decrementar `reservado_fiscal` | o mesmo fato físico pode existir nas duas tabelas? | ALTO se sim |
| Revert NF-e vs distribuição original | `estoqueNfeDevolucaoVenda.js` | `reverterEstoqueNfeDevolucaoVenda` | só SF+EA | devolução original mista NF? | ALTO |
| Lotes vs invariante | `lotesService.js` | `atualizarEstoqueConsolidado` | EA = soma lotes | lotes são o estoque real ou só validade? | ALTO para significado de EA |
