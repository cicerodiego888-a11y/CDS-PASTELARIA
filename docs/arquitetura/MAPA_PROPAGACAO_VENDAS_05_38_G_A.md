# MAPA DE PROPAGAÇÃO — Vendas 05.38.G.A

**Classificação:** SOMENTE LEITURA  
**Data:** 2026-08-24

---

## 1. Origens reais de criação de venda (comprovadas)

| # | ORIGEM | ENTRADA | WRITER | PERSISTE `vendas`? |
|---|--------|---------|--------|-------------------|
| O1 | **PDV Universal checkout** | `POST /api/pdv-universal/checkout` → `finalizarCheckout` → adapter → `POST /api/vendas` | W1 | Sim |
| O2 | **PDV legado / ERP PDV** | `POST /api/vendas` (origem PDV) | W1 | Sim |
| O3 | **ERP manual** | `POST /api/vendas` | W1 | Sim |
| O4 | **Entrega** | `POST /api/vendas` (`tipo_venda=ENTREGA`) | W3 | Sim |
| O5 | **MUV MULTI — materializar** | `POST /api/pdv-universal/atendimentos/:id/materializar` → `MaterializarOperacoesAtendimento` | W2 | Sim (+ `atendimento_operacoes.venda_id`) |
| O6 | **MUV MULTI — preview** | `VendaApplicationService` MULTI → `AtendimentoMultiempresaService.criarAtendimento` | — | **Não** (só atendimento) |
| O7 | **Faturamento** | `VendaApplicationService` — origem FATURAMENTO delega W1 | W1 | Sim |
| O8 | **Pedido → venda** | `pedido_id` no body; reserva consumida após baixa (RC4.1.2) | W1 | Sim |
| O9 | **PDV Express** | Não encontrado módulo/rota separada nomeada "PDV Express"; PDV legado usa mesmo `POST /api/vendas` | W1 | Sim |

**Conclusão:** três INSERTs de produção; **W1 é o writer canônico** para ERP/PDV. MUV adiciona ponte `atendimento_operacoes.empresa_id` sem gravar empresa na venda.

---

## 2. Fluxo canônico (POST /api/vendas → W1)

```
ORIGEM (PDV | ERP | Universal | Entrega*)
  ↓
Frontend: cds_empresa_id → CdsEmpresaContexto → X-Empresa-Id (quando configurado)
  ↓
verificarToken (server.js)
  ↓
router.use(criarMiddlewareContextoEmpresa(db))   // obrigatorio=false → req.empresaId pode ser null
  ↓
validarCaixaSeOrigemPdv (se origem PDV)
  ↓
VendaApplicationService.criarVenda
  ├─ EMPRESA_SIMPLES → VendaPagamentoService.criarVenda
  └─ MULTIEMPRESA → AtendimentoMultiempresa (sem INSERT vendas neste POST)
  ↓
VendaPagamentoService.criarVenda
  ↓
resolverEmpresaIdParaFinanceiro(req)  // FinanceiroEmpresaContextoService — UMA vez
  → req.empresaId := empresa resolvida
  ↓
montarOpcoesBaixaEstoqueVenda(req)  // empresaId = req.empresaId (pode null → COMPAT)
  ↓
BEGIN
  INSERT INTO vendas (...)              // SEM empresa_id
  INSERT INTO vendas_itens (...)
  debitoEstoque / FEFO                  // empresaId do req ou COMPAT legado
  INSERT venda_pagamentos (...)
  INSERT financeiro / contas_receber    // empresa_id = req.empresaId
  [opcional] emitirFiscalSeSolicitado   // emitirPorVendaId SEM empresaId explícito
COMMIT
```

\* Entrega desvia para `CriarVendaEntregaService` antes do INSERT principal.

---

## 3. Fluxo MUV MULTI (materialização)

```
Checkout MULTI → atendimento + operacoes (empresa_id POR operação)
  ↓
Pagamento / materializar
  ↓
MaterializarOperacoesAtendimento.persistirVendaOperacao
  → operacao.empresaId validado nos itens
  → INSERT vendas (SEM empresa_id)
  → UPDATE atendimento_operacoes SET venda_id = ?
  → INSERT financeiro (legado path pode omitir empresa_id — ver W2 L228)
  ↓
FiscalizarAtendimentoService (opcional)
  → emitirPorVendaId(vendaId, { empresaId })  // empresa da OPERACAO — correto
```

**Quebra:** venda materializada **não carrega** `empresa_id`; ownership posterior depende de join com `atendimento_operacoes` ou contexto HTTP.

---

## 4. Matriz de fronteiras

| Fronteira | `empresa_id` na entidade | Fonte | Persistido? | Validação cruzada? | Classe |
|-----------|--------------------------|-------|-------------|-------------------|--------|
| Origem → Venda | **Não** | Header / Contrato / caixa | **Não** | Middleware opcional | **R6 AUSENTE** |
| Venda → Estoque | Na operação | `req.empresaId` | `estoque_empresa` ou COMPAT | `exigirEmpresa` **não** default em W1 | **R3 PARCIAL / P0** |
| Venda → Financeiro | No lançamento | `req.empresaId` (resolvido 1×) | Sim | Sem checar venda (inexistente) | **R2 CONECTAR** |
| Venda → Caixa | Sessão sim / venda não | `caixa_sessao_id` | Sessão sim | `validarCaixaAberto` compara sessão×contexto | **R3 PARCIAL** |
| Venda → NFC-e | Nota sim / venda não | Emissor: `opcoes.empresaId` ou **global** | Parcial | MUV sim; W1 **não** passa empresa | **R3 PARCIAL / P0** |
| Consulta GET/list | — | — | — | `WHERE id = ?` only | **R6 AUSENTE** |
| Cancel / devolver | — | `req.empresaId` estorno | — | Sem ownership venda | **R6 AUSENTE** |

Legenda: R1 reutilizar · R2 conectar · R3 parcial · R4 centralizar · R5 duplicado · R6 ausente

---

## 5. EMPRESA_SIMPLES vs MULTIEMPRESA

### EMPRESA_SIMPLES

| Etapa | Comportamento |
|-------|---------------|
| Resolução | `FinanceiroEmpresaContextoService` → `ContratoOperacionalService.empresa_operacional` antes do INSERT |
| Venda persistida | **Sem** `empresa_id` |
| Estoque | `req.empresaId` após resolução financeira → normalmente empresa operacional |
| Financeiro | Mesma `req.empresaId` |
| Caixa | Sessão pode herdar `empresa_id`; middleware preenche `req.empresaId` da sessão se ausente |
| Fiscal (W1) | `emitirPorVendaId(vendaId)` **sem** `empresaId` → `getFiscalConfig()` **global ou primeira empresa** |

**Risco:** múltiplas resoluções independentes **antes** do INSERT (financeiro OK; fiscal/emissor pode divergir se config global ≠ operacional).

### MULTIEMPRESA

| Etapa | Comportamento |
|-------|---------------|
| POST /vendas | Cria **atendimento**, não venda (W1 não roda) |
| Checkout Universal | `finalizarCheckoutMultiempresa` → atendimento |
| Materializar | W2; empresa em `atendimento_operacoes` |
| Estoque na reserva | `empresa_id` obrigatório no MUV |
| GET/cancel venda | **Sem filtro empresa** — cruzamento possível |

---

## 6. PDV e contexto empresarial

| Mecanismo | Evidência |
|-----------|-----------|
| `cds_empresa_id` (localStorage) | `frontend/shared/js/cds-empresa-contexto.js`, PDV Universal |
| `X-Empresa-Id` | Middleware `empresaContexto.js` |
| Empresa do caixa | `validarCaixaAberto.js` — `req.empresaId` ← `sessao.empresa_id` se null |
| Empresa persistida na venda | **Não** |

**Perguntas obrigatórias (evidência):**

| Ação | Venda A consultável/cancelável em contexto B? |
|------|-----------------------------------------------|
| GET `/:id` | **Sim** — `WHERE id = ?` sem empresa |
| Cancelar | **Sim** — idem; estoque usa `req.empresaId` do contexto B |
| Baixa financeira | **Parcial** — financeiro criado com empresa A; cancelamento por `venda_id` sem filtro empresa |
| Emitir NFC-e (W1) | **Risco** — emissor sem `empresaId` usa config global; venda A pode emitir como config B |
| Estoque cancelamento | **Risco** — crédito na empresa do header B |

---

## 7. Venda × Caixa (05.38.C)

| Entidade | `empresa_id` |
|----------|--------------|
| `caixa_sessoes` | **Sim** |
| `vendas` | **Não** (só `caixa_sessao_id`) |

Validações (`validarCaixaAberto.js`):

- Abertura: `exigirSessaoDaEmpresa(sessao, empresaId)` quando contexto presente.
- Cancel/devolver: carrega venda → obtém `caixa_sessao_id` → valida sessão × empresa do request.

**Gap:** não compara `venda`×empresa (inexistente); só sessão×contexto. Venda orfa ou sessão legado sem empresa → caminhos mais fracos.

---

## 8. Venda × Estoque

Porta: `debitoEstoqueVendaViaPorta` / `creditoEstoqueVendaViaPorta`.

| Cenário | Comportamento |
|---------|---------------|
| `req.empresaId` presente | Débito/crédito em `estoque_empresa` |
| Ausente + `exigirEmpresa !== true` | **COMPAT** → colunas em `produtos` |
| W1 criação | `montarOpcoesBaixaEstoqueVenda` — **não** seta `exigirEmpresa: true` por default |

**Classificação:** **PARCIAL** (MULTI na reserva MUV = SEGURO; W1 ERP/PDV = INSEGURO se header ausente).

---

## 9. Venda × Financeiro

| Aspecto | Evidência |
|---------|-----------|
| `financeiro.empresa_id` | Preenchido com `req.empresaId` no INSERT (`VendaPagamentoService` ~L1282, L1646) |
| Resolução | `resolverEmpresaIdParaFinanceiro` **antes** do INSERT — alinhado com 05.38.D |
| Origem dominio | **Não** usa `venda.empresa_id` (inexistente) |
| Cancelamento | `cancelarFinanceiroVenda(vendaId)` — filtra por `venda_id` only |
| Estorno cancelamento | INSERT despesa **sem** `empresa_id` (`VendaCancelamentoService` ~L117) |

**Classificação:** criação **PARCIAL** (contexto OK, venda sem ownership); cancelamento estorno **INSEGURO** em MULTI.

---

## 10. Venda × Fiscal

```
venda (sem empresa_id)
  ↓
VendaFiscalService.emitirFiscalSeSolicitado → emitirPorVendaId(vendaId)  // sem empresaId
  ↓
getFiscalConfig({})  // config GLOBAL se empresaId omitido
  ↓
nfce_notas.empresa_id = opcoes.empresaId || null
```

**Exceção MUV:** `FiscalizarAtendimentoService` passa `empresaId` da operação — **SEGURO**.

**Pergunta:** venda A pode emitir com config B? **Sim**, no fluxo W1/W3 se `emitirPorVendaId` não receber `empresaId` e existir config global ou ambiguidade.

---

## 11. Pagamentos

| Tabela | `empresa_id` | Herança |
|--------|--------------|---------|
| `venda_pagamentos` | Não | Apenas `venda_id` |
| `venda_recebimentos` | Não | Idem |
| TEF (`tef_transacoes`) | Verificar | Vinculado `venda_id` |

Pagamento misto, PIX, cartão, dinheiro: **sem coluna empresa**; dependem de caixa/sessão/contexto HTTP na criação.

---

## 12. Cancelamento / devolução / consultas

| Operação | SQL / guard |
|----------|-------------|
| `GET /api/vendas/:id` | `WHERE v.id = ?` |
| `GET /api/vendas` | Sem `empresa_id`; filtro data/busca |
| `PUT/POST cancelar` | `SELECT * FROM vendas WHERE id = ?` |
| `POST devolver` | Idem |
| `DELETE /:id` | Idem |
| Relatórios fechamento | `WHERE data_venda BETWEEN` — sem empresa |

**Gap central:** ownership **AUSENTE** na entidade venda.

---

## 13. Declaração

Documento **somente leitura**. Nenhuma alteração de código.
