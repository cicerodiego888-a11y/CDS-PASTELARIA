# Arquitetura oficial — Motor Universal de Vendas (v1)

**Sprint:** 04.01 · **Data:** 2026-08-21 · **Status:** decisão documentada (sem orquestração funcional)

Este documento é o contrato das próximas Sprints. Não substitui o PDV, a tabela `vendas`, o Motor Comercial nem o MTS.

---

## 1. Decisão oficial da entidade universal

**Escolha: ATENDIMENTO** (não VENDA_MESTRE).

### Por que não VENDA_MESTRE

A tabela `vendas` já é o documento comercial **concluído**:

- um `id` concentra caixa, TEF, fiscal F×NF, pagamentos, recebimentos, itens e financeiro;
- Pedido vira `vendas` via Faturamento (`origem=FATURAMENTO`, `pedido_id`);
- Entrega é `tipo_venda=ENTREGA` na mesma tabela, não um pai conceitual.

Chamar o agrupamento multiempresa de “venda mestre” misturaria o checkout do cliente com o documento que o SEFAZ, o caixa e o contas a receber já conhecem.

### Por que ATENDIMENTO

No código já existe um **núcleo transacional** (`VendaApplicationService`) e **origens/canais** (`VendaOrigin`: PDV, PEDIDO, FATURAMENTO, NF_AVULSA, …). O PDV já é tratado como canal, não como o núcleo.

ATENDIMENTO é o conceito superior que o sistema ainda não persiste:

- um cliente, um checkout, uma experiência;
- N **operações empresariais**, cada uma podendo se tornar uma `vendas` existente;
- cabe mesa/comanda, cardápio online, delivery e PDV sem duplicar `vendas`.

A tabela `vendas` **não é substituída**. No MULTIEMPRESA, cada operação empresarial continua sendo (futuramente) uma linha de `vendas` com `empresa_id` explícito.

```
ATENDIMENTO                    ← conceito universal (novo)
        │
        ├── Operação Empresa A → vendas (existente)
        ├── Operação Empresa B → vendas (existente)
        └── Operação Empresa C → vendas (existente)
```

---

## 2. Modos EMPRESA_UNICA e MULTIEMPRESA

Configuração explícita: `modo_operacao_venda`.

| Valor | Comportamento |
|---|---|
| `EMPRESA_UNICA` (default) | Um atendimento → uma operação → uma `vendas`. Equivale ao PDV atual. |
| `MULTIEMPRESA` | Um atendimento → N operações, uma por empresa. O cliente vê um checkout. |

Não existe modo derivado de CNPJ, “empresa 1” ou nicho (pastelaria). Qualquer instalação escolhe o modo.

**Onde mora:** `configuracoes.json` da instalação (mesmo mecanismo de `configuracaoService`: diretório persistente, não JWT). Escopo = **instalação/ambiente**, não por usuário e não por produto.

**Resolução:** `resolverModoOperacaoVenda(fonte)` em `backend/motores/muv/contratos.js`. Ausente → `EMPRESA_UNICA`. Valor desconhecido → erro. Ainda **não** está ligado ao `configuracaoService` (próxima Sprint de implementação).

---

## 3. Diagrama conceitual

### EMPRESA_UNICA

```
CANAL (PDV | Pedido | Delivery | Cardápio | …)
        │
        ▼
   ATENDIMENTO
        │
        ▼
 OPERAÇÃO EMPRESARIAL  (empresaId = req.empresaId)
        │
        ▼
     vendas
        ├── estoque_empresa
        ├── reservas
        ├── caixa_sessao
        ├── venda_pagamentos / venda_recebimentos
        └── NFC-e / NF-e da mesma empresa
```

### MULTIEMPRESA

```
                    ATENDIMENTO
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     Operação A     Operação B     Operação C
     empresa A      empresa B      empresa C
          │              │              │
          ▼              ▼              ▼
       vendas A       vendas B       vendas C
```

Pagamento do cliente: um total. Distribuição interna: soma das operações = total.

---

## 4. Operação empresarial

Contrato: **exige `empresaId` validado** (`req.empresaId` no HTTP). Body, query, `contexto`, CNPJ e `empresa_id` no payload **não** inventam empresa.

Cada operação:

- consulta/baixa/reserva estoque **só** daquela empresa (portas 03.35 / 03.36);
- emite fiscal **só** no CNPJ daquela empresa;
- registra caixa/financeiro **só** daquela empresa.

Mapeamento futuro 1:1 com `vendas`. Hoje `vendas` **não tem** coluna `empresa_id` (risco: isolamento só nas escritas de estoque via `req.empresaId`).

---

## 5. Contrato de itens

O **produto permanece global**. Não existe `produtos_empresa`.

| Modo | Empresa do item |
|---|---|
| EMPRESA_UNICA | Herdada da operação (`req.empresaId`). |
| MULTIEMPRESA | **Obrigatória no item no momento do carrinho.** Não vem do cadastro do produto. |

Origem da empresa do item (MULTIEMPRESA):

1. escolha operacional no canal (qual loja/banca está vendendo aquele SKU);
2. não copiar do catálogo;
3. alteração manual só com regra futura de autorização;
4. item sem `empresaId` no modo MULTIEMPRESA é inválido.

Impedir mistura: itens da operação A só podem ter `empresaId` A. O Motor Universal agrupa o carrinho por `empresaId` **antes** de chamar o núcleo atual.

---

## 6. Contrato de estoque

Reutilizar a Fundação Multiempresa. Sem estoque paralelo.

Cada operação passa `empresaId` para:

| Porta | Status hoje |
|---|---|
| `consultarSaldo` | 03.35 — lê `estoque_empresa` |
| `consultarDisponibilidade` | 03.36 — lê `estoque_empresa` |
| reservar / liberar | 03.20 dual-write + 03.26 PDV |
| baixar / retornar | 03.25 / 03.31 via porta |
| MTS | 03.29–03.35 — usa a porta |

Sem `empresaId`: COMPAT / `produtos`. Isso permanece até a instalação exigir header.

---

## 7. Contrato de pagamento

O cliente paga **um** valor. Internamente:

`soma(distribuições por empresa) = total do pagamento` (tolerância 1 centavo).

Estratégias futuras (não implementadas):

| Estratégia | Ideia |
|---|---|
| `POR_ITEM` | Rateio pelo subtotal dos itens de cada operação (recomendação inicial). |
| `PROPORCIONAL` | Rateio pelo peso do total de cada operação. |
| `MANUAL` | Operador informa valores; o contrato só valida a soma. |

Canais (reuso, sem alterar TEF agora):

- PIX / dinheiro / cartão / TEF / misto já passam por `OrquestradorPagamento` + `venda_pagamentos` / `venda_recebimentos` **por venda**.
- No MULTIEMPRESA, cada operação recebe a fatia e grava **seus** recebimentos. TEF único do checkout precisará, numa Sprint posterior, de política de vínculo (uma TEF no atendimento vs TEF por operação). **Não alterar TEF nesta Sprint.**

---

## 8. Contrato fiscal

Uma empresa **nunca** emite documento no CNPJ de outra.

Hoje a venda tem `valor_fiscal` / `valor_nao_fiscal` e itens `item_fiscal` — isso é F×NF **dentro da mesma empresa**, não multi-CNPJ.

No MULTIEMPRESA: NFC-e/NF-e por operação (por `vendas`). Sem emissão multiempresa nesta Sprint.

---

## 9. Atomicidade

A venda atual usa `BEGIN IMMEDIATE` no mesmo SQLite (`VendaPagamentoService.criarVenda`).

**Decisão:** `ROLLBACK_TOTAL` enquanto todas as operações do atendimento estiverem no **mesmo banco e na mesma transação**.

Se uma operação falhar, nenhuma `vendas` do atendimento é commitada.

Bancos distribuídos (futuro): documentar Saga/compensação. **Não implementar Saga agora.**

---

## 10. Integração com legado

Ponto de inserção: **`VendaApplicationService`** (porta já existente).

```
Canal HTTP (POST /api/vendas, Faturamento, Entrega)
        │
        ▼
VendaApplicationService          ← política de origem (já existe)
        │
        ▼
Motor Universal (futuro)         ← agrupa por empresa / modo
        │
        ▼
VendaPagamentoService.criarVenda ← núcleo atual, N vezes se MULTIEMPRESA
```

Reutiliza: Motor Comercial, MTS, portas F×NF, `EstoqueReservaService`, TEF, financeiro.

Não cria: novo estoque, novo MTS, novo Motor Comercial, novo PDV.

`POST /api/vendas` permanece. PDV atual permanece. COMPAT da fundação permanece.

---

## 11. Fluxos auditados (código real)

### 11.1 PDV / balcão

```
Identificação produto
  frontend/pdv + MIP / GET produtos (overlay 03.21–03.23)
        │
Carrinho (frontend)
        │
POST /api/vendas/pre-calcular-distribuicao
  VendaPagamentoService.preCalcularDistribuicao
  overlay aplicarSaldosDisponibilidadeVenda (req.empresaId)
        │
POST /api/vendas
  rotas/vendas.js → VendaApplicationService.criarVenda
        │ origem PDV
  VendaPagamentoService.criarVenda
        │ tipo_venda=ENTREGA → CriarVendaEntregaService (desvio)
        │
  SELECT produtos + overlay estoque_empresa
  Motor F×NF (distribuição fiscal/não fiscal)
  OrquestradorPagamento (PIX / dinheiro / TEF / misto)
        │
  BEGIN IMMEDIATE
    INSERT vendas
    venda_recebimentos / venda_pagamentos
    UPDATE tef_transacoes.venda_id
    INSERT vendas_itens
    debitarEstoqueItemVenda (porta + dual-write)
    financeiro / contas_receber (prazo)
  COMMIT ou ROLLBACK
```

| Etapa | Arquivo | Função | empresaId | Tabelas |
|---|---|---|---|---|
| Porta HTTP | `rotas/vendas.js` | `POST /` | middleware `req.empresaId` | — |
| Política origem | `VendaApplicationService.js` | `criarVendaComContexto` | context.empresa **ainda lê body** (não é autoridade de estoque) | — |
| Núcleo | `VendaPagamentoService.js` | `criarVenda` | `montarOpcoesBaixaEstoqueVenda(req)` | `vendas`, itens, pagamentos |
| Estoque leitura | `leituraEstoqueEmpresaProduto.js` | overlay | `req.empresaId` | leitura EE |
| Estoque baixa | `debitoEstoqueVendaViaPorta.js` | `debitarEstoqueItemVenda` | `req.empresaId` | `produtos` + `estoque_empresa` |
| Pagamento | `OrquestradorPagamento.js` | `processarFluxoPagamentoVenda` | não isolado por empresa | TEF / PIX |
| Reserva PDV/entrega | `EstoqueReservaService.js` | `reservarItem` | `req.empresaId` | `venda_estoque_reservas` + porta |

### 11.2 Pedido → Expedição → Venda

```
POST pedidos (reserva fiscal via Motor Comercial → reservasPublico 03.36 → MTS 03.35)
        │
FaturamentoService
        │ origem FATURAMENTO + pedido_id
VendaApplicationService → VendaPagamentoService
        │
consumo reserva (pedidoReservaPonteNucleo) + baixa
```

### 11.3 Entrega

`tipo_venda=ENTREGA` desvia para `CriarVendaEntregaService`: cria `vendas` + reserva (`reservarItem`) sem baixa imediata. Prestação posterior baixa.

### 11.4 Entidades

| Tabela | Papel | empresa_id hoje? |
|---|---|---|
| `vendas` | Documento comercial concluído | **não** |
| `vendas_itens` | Itens da venda; produto global | **não** |
| `venda_pagamentos` | Parcelas de forma (misto/TEF) | não |
| `venda_recebimentos` | Recebimentos F/NF | não |
| `tef_transacoes` | TEF; `venda_id` | não |
| `caixa` / `caixa_sessoes` | Caixa do PDV | não |
| `contas_receber` / `financeiro` | Prazo / livro | não |
| `nfce_notas` / `nfe_notas` | Fiscal | empresa no cadastro fiscal, não na venda |
| `pedidos` / `pedidos_itens` | Pré-venda | contexto HTTP, não coluna |
| `venda_estoque_reservas` | Reserva entrega/PDV | via porta |
| `clientes` | Cadastro global | compartilhado |
| `produtos` | Cadastro global | compartilhado |
| `estoque_empresa` | Saldo isolado | sim |

---

## 12. Riscos

1. `vendas` e `vendas_itens` sem `empresa_id` — relatórios/caixa misturam empresas se só o estoque estiver isolado.
2. `VendaContext.empresa` ainda pode ler `body.empresa` — **não** é a autoridade (estoque usa `req.empresaId`).
3. TEF/PIX hoje amarram a **uma** venda; checkout único multiempresa precisa de política futura.
4. Caixa/sessão não têm empresa — EMPRESA_UNICA ok; MULTIEMPRESA exige regra de caixa por operação.
5. Pedido reserva estoque de **uma** empresa por confirmação; carrinho multiempresa no Pedido ainda não existe.
6. Relatórios e dashboard ainda leem `produtos` / vendas sem filtro de empresa.

---

## 13. Próximas Sprints (ordem)

1. **04.02** — Ligar `modo_operacao_venda` em `configuracaoService` (default `EMPRESA_UNICA`) + resolver no `VendaApplicationService` sem mudar o fluxo PDV.
2. **04.03** — Persistência mínima de ATENDIMENTO (schema) **sem** migrar vendas antigas.
3. **04.04** — EMPRESA_UNICA: atendimento 1:1 com a venda atual (compatível, feature flag).
4. **04.05** — Agrupar itens por `empresaId` e chamar o núcleo N vezes **dentro da mesma TX**.
5. **04.06** — Distribuição de pagamento `POR_ITEM` (contrato já definido).
6. **04.07** — documentos fiscais por operação (reuso do emissor NFC-e) + contrato do Comprovante Unificado.
7. **04.08** — configuração/numeração fiscal por empresa + materialização de `quantidade_fiscal`/`valor_fiscal`.
8. **04.09** — gestão backend da configuração fiscal por empresa (rotas, status, segredos).
9. **04.10** — comprovante unificado (DTO + GET, sem impressão física).
10. **04.11** — renderização TEXT/HTML do comprovante (sem ESC/POS).
11. **04.12** — adaptador de impressão (PREVIEW / BROWSER / THERMAL preparado; sem impressão física real).
12. **04.13** — UI do comprovante unificado no PDV (consome GET comprovante / POST imprimir BROWSER).
13. **04.14** — auditoria de prontidão: Fase 05 apta (decisão B). Sem nova UI.
14. **05.01** — fundação do PDV Universal (contexto, capabilities, adaptadores). Sem UI completa.
15. **05.02** — contexto operacional e seleção de empresa (sem tela principal).
16. **05.03** — tela principal do PDV Universal (contexto visual; sem carrinho).
17. **05.04** — carrinho universal + identificação operacional por empresa.
18. **05.05** — checkout EMPRESA_UNICA (VendaApplicationService).
19. **05.06** — checkout MULTIEMPRESA (Atendimento MUV VALIDADO; sem pagamento).
20. **05.07** — pagamento unificado visual + reserva (para em PAGO).
21. **05.08** — materialização + fiscalização + comprovante no fluxo visual.
22. **05.09** — preview e preparação de impressão (BROWSER/HTML) no PDV Universal.
23. **05.10** — estabilização operacional (sessão visual, locks, recuperação, reset). Fecha a Fase 05.
24. **05.11** — gestão visual de empresas + configuração fiscal por CNPJ (APIs 04.08/04.09).
25. **05.12** — ativação visual: menu oficial abre o PDV Universal existente.
26. **05.13** — auditoria visual e correção de conexão UI do PDV Universal.

Não iniciar recursos de nicho automaticamente nesta Sprint.

---

## 14. Explicitamente proibido (04.01 e fundação)

- Novo PDV visual / remover PDV / atalhos
- Alterar TEF, fiscal, Motor Comercial, MTS
- Migrar vendas existentes
- `empresa_id` em massa em `vendas_itens`
- Venda ou pagamento multiempresa **funcionais**
- Tabelas de atendimento **nesta** Sprint (só contrato)
- Desligar COMPAT / `produtos` legado
- Alterar `estoque_empresa` / backfill automático
- Duplicar produto por empresa
- Inventar empresa por CNPJ ou “empresa 1”
