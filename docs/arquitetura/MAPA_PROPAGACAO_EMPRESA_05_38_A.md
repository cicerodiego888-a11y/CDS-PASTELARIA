# MAPA DE PROPAGAÇÃO — empresa / modo operacional (05.38.A)

Auditoria somente leitura. Fluxos baseados em código real.

---

## 1. Modo operacional (vendas) — camada existente

```
config.json (userData)
  chave: modo_operacao_venda
  valores: EMPRESA_UNICA | MULTIEMPRESA
        ↓
configuracaoService.obterModoOperacaoVenda()
        ↓
motores/muv/modoOperacaoVenda.resolverModoOperacaoVendaAtivo()
        ↓
┌─────────────────────────────┬──────────────────────────────┐
│ EMPRESA_UNICA               │ MULTIEMPRESA                 │
├─────────────────────────────┼──────────────────────────────┤
│ VendaApplicationService     │ AtendimentoMultiempresaService│
│  → VendaPagamentoService    │  → atendimentos / reservas    │
│ PDVUniversalApplication     │  → pagamento unificado MUV    │
│  → EmpresaUnicaAdapter      │  → materialização / fiscal MUV│
│  → POST /vendas             │ PDVUniversalApplication       │
│                             │  → MultiempresaAdapter        │
└─────────────────────────────┴──────────────────────────────┘
```

**Contexto ausente neste fluxo:** Central de Entradas, caixa, financeiro, dashboard — **não leem** `modo_operacao_venda`.

**Contexto duplicado:** nenhum segundo resolver de modo encontrado; consumidores chamam o mesmo `resolverModoOperacaoVendaAtivo`.

---

## 2. Empresa / `empresa_id` — propagação real

### 2.1 Configuração → sessão frontend

| Etapa | Mecanismo | Evidência |
|-------|-----------|-----------|
| Seleção operador | `PUT /pdv-universal/contexto/empresa` ou ERP | `pdv-universal.js`, `EmpresaService.selecionarEmpresaContexto` |
| Persistência local | `localStorage.cds_empresa_id` | `cds-empresa-contexto.js` |
| Header API | `X-Empresa-Id` | PDV Universal, ERP produtos, PDV legado (parcial) |

### 2.2 Frontend → API → service → banco

| Módulo | Front envia? | API recebe? | Service usa? | Banco persiste? |
|--------|--------------|-------------|--------------|-----------------|
| **PDV Universal contexto** | Sim (header) | Sim (`resolverEmpresaIdDaRequisicao`) | `PDVUniversalContextService` | Não (só sessão) |
| **PDV Universal item** | Sim (`empresa_id` no item) | Sim (checkout body) | MUV / `PDVUniversalVendaAdapter` | `atendimento_*` / `vendas` |
| **Estoque consulta** | Sim (header) | Sim (`req.empresaId` middleware) | `estoqueSaldosPublico` | `estoque_empresa` |
| **Produtos listagem** | Sim (header) | Sim | join `estoque_empresa` | leitura |
| **Compras crédito** | Contexto | Sim | porta compras | dual-write |
| **Fiscal NFC-e** | `empresaId` opções | Sim | `emissor.js`, `empresas_configuracao_fiscal` | `nfce_notas.empresa_id` |
| **Caixa** | **Não** | **Não** | `obterConfigsEmpresa` (config global) | `caixa_sessoes` sem empresa |
| **Financeiro** | **Não** | **Não** | lançamentos globais | sem `empresa_id` |
| **Central Entradas docs** | N/A | CNPJ implícito | repositórios | `cnpj` / `cnpj_fornecedor` |
| **Central NSU** | N/A | CNPJ+ambiente | `CentralNsuRepository` | `central_entradas_nsu` |
| **Vendas legado** | Parcial header | Parcial | `VendaPagamentoService` | `vendas` sem coluna empresa |

### 2.3 Diagrama consolidado

```
CONFIG (modo_operacao_venda)          EMPRESA (empresas.id)
         │                                      │
         │ (só vendas/PDV)                      │ X-Empresa-Id + item.empresa_id
         ▼                                      ▼
   modoOperacaoVenda.js              empresaContexto.js (middleware)
         │                                      │
         ├─► VendaApplicationService            ├─► estoqueSaldosPublico → estoque_empresa
         ├─► PDVUniversalApplication            ├─► produtos (listagem)
         └─► Adaptadores PDV                    ├─► compras (porta)
                                                ├─► emissor fiscal
                                                └─► MUV (operacao.empresaId)

         ✗ caixa.js (config global)
         ✗ financeiro / contas_receber
         ✗ relatórios vendas
         ✗ Central docs (sem empresa_id)
```

---

## 3. Classificação por tipo de contexto

| Tipo | Exemplos |
|------|----------|
| **Explícito** | `X-Empresa-Id`, `item.empresa_id`, `opts.empresaId` em estoque |
| **Implícito legado** | `configuracoes.cnpj` (caixa, partes central) |
| **Implícito por CNPJ** | NSU SEFAZ (`cnpj+ambiente`) |
| **Ausente** | `financeiro`, `caixa_sessoes`, matriz relatórios |
| **Duplicado** | CNPJ config vs `empresas`; saldo `produtos` vs `estoque_empresa` |

---

## 4. MULTIEMPRESA — fluxo PDV (já implementado)

```
GET /pdv-universal/contexto
  → modo_operacao: MULTIEMPRESA
  → capacidades.checkout_multiempresa
        ↓
POST /pdv-universal/checkout
  → criarAtendimento (itens com empresa_id)
        ↓
POST .../reservar → reserva estoque por operação
        ↓
POST .../pagamento → pagamentos[] + rateio POR_ITEM
        ↓
POST .../materializar → vendas por empresa (MaterializarOperacoesAtendimento)
        ↓
POST .../fiscalizar → FiscalizarAtendimentoService
```

**Isolamento item:** `produto_id + empresa_id` no carrinho Universal (`pdv-universal-cart.js`).

---

## 5. EMPRESA_SIMPLES (alvo) vs EMPRESA_UNICA (código)

| Aspecto | EMPRESA_UNICA hoje | EMPRESA_SIMPLES desejada |
|---------|-------------------|-------------------------|
| Várias empresas cadastradas | Pode exigir seleção | Não deve exibir complexidade |
| MUV | Desligado pelo modo | Desligado |
| Rateio | Não | Não |
| Header empresa | Pode ser necessário se N>1 | Deve ser transparente (1 CNPJ) |

**GAP:** comportamento “simples” requer **modo global** + política “única empresa operacional” distinta de “MULTI com 1 registro”.
