# Porta Pública de Saldos — Multiempresa (Fase 1 / Implementação 01)

**Status:** contrato preparado · storage ainda em `produtos`  
**Data:** 2026-08-12  
**Escopo:** `backend/services/fiscalNaoFiscal/*`

---

## 1. Objetivo

Introduzir **empresaId/contexto** na porta pública de saldos e reservas **sem**:

- criar `estoque_empresa`;
- migrar saldos;
- alterar regras Fiscal × Não Fiscal;
- alterar `distribuidorEstoqueVenda`, MIDP, MPFC, MTS (regra F↔NF), cancelamento/devolução;
- alterar MUC, MIIP, TEF ou Central de Entradas.

---

## 2. Contrato anterior

```js
consultarSaldo(produtoId, { db })
debitarSaldo(produtoId, tipo, quantidade, { db })
creditarSaldo(produtoId, tipo, quantidade, { db })
transferirSaldoEntreTipos({ produtoId, origem, destino, quantidade }, { db })
consultarDisponibilidade(produtoId, { db })
criarReservaFiscal({ pedidoId, produtoId, quantidade }, { db })
```

Retorno principal: `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_total`.

---

## 3. Contrato novo

Vocabulário alinhado ao CDS existente: `empresaId` / `empresa_id` (mesmo padrão de `VendaContext`, FeatureFlags, DfeAuditoria).

```js
consultarSaldo(produtoId, { empresaId, db })
consultarSaldo({ produtoId, empresaId, db })

debitarSaldo(produtoId, tipo, quantidade, { empresaId, db })
creditarSaldo(produtoId, tipo, quantidade, { empresaId, db })

transferirSaldoEntreTipos({
  produtoId,
  empresaId,
  origem,   // FISCAL | NAO_FISCAL
  destino,  // FISCAL | NAO_FISCAL
  quantidade
}, { db })

consultarDisponibilidade(produtoId, { empresaId, db })
criarReservaFiscal({ pedidoId, produtoId, empresaId, quantidade }, { db })
criarReservaNaoFiscal({ pedidoId, produtoId, empresaId, quantidade }, { db })
```

### Retorno enriquecido (`consultarSaldo`)

| Campo | Significado |
|---|---|
| `produto_id` | Produto global |
| `empresa_id` | Contexto (ou `null` em modo legado explícito) |
| `saldo_fiscal` / `saldo_nao_fiscal` | Ledgers F×NF |
| `estoque_atual` / `estoque_total` | Sempre `SF + SNF` |
| `reservado_fiscal` / `reservado_nao_fiscal` | Reservas |
| `disponivel_fiscal` | `max(0, SF − reservado_fiscal)` |
| `disponivel_nao_fiscal` | `max(0, SNF − reservado_nao_fiscal)` |
| `legado` | `true` somente com flag explícita de compat |

---

## 4. Como obter empresaId

1. **Preferencial:** `opts.empresaId` / `opts.empresa_id` (ou no objeto params).
2. **Validação:** se a tabela `empresas` existir no DB, o ID deve existir (`EMPRESA_NAO_ENCONTRADA`).
3. **Callback:** `opts.validarEmpresa(id)` para testes/integração.
4. **Sem inventar default:** não usa CNPJ de `configuracoes`, nem “empresa 1” implícita.

Códigos de erro:

| Code | Quando |
|---|---|
| `EMPRESA_OBRIGATORIA` | Contexto ausente |
| `EMPRESA_NAO_ENCONTRADA` | ID inválido na tabela `empresas` / validator |
| `PRODUTO_NAO_ENCONTRADO` | Produto inexistente |
| `SALDO_INSUFICIENTE` | Débito/reserva sem saldo |

---

## 5. Compatibilidade certificada (explícita)

Fluxos já certificados (Motor Comercial / pedido) que ainda **não** possuem empresa no modelo usam:

```js
const { COMPAT_CERTIFICADA_PRE_MULTIEMPRESA } = require('.../empresaContexto');
// { modoLegadoSemEmpresa: true, motivoCompat: 'COMPAT_CERTIFICADA_PRE_MULTIEMPRESA' }
```

- **Não é fallback silencioso** — o chamador deve setar o flag.
- **Proibido** em operações que já conheçam a empresa ativa.
- Storage e matemática F×NF permanecem idênticos.

---

## 6. Invariantes preservadas

```
estoque_atual = saldo_fiscal + saldo_nao_fiscal
disponivel_fiscal = max(0, saldo_fiscal - reservado_fiscal)
disponivel_nao_fiscal = max(0, saldo_nao_fiscal - reservado_nao_fiscal)
```

`transferirSaldoEntreTipos` = **Fiscal ↔ Não Fiscal do mesmo produto + mesma empresa**.  
**Não** é transferência entre CNPJs.

---

## 7. Storage atual (limitação)

Saldos e `reservado_*` continuam em `produtos`.  
A empresa entra no **contrato e validação**; o isolamento físico virá com `estoque_empresa` em Sprint futura.

Mutadores SQL diretos (compras, venda, ajuste, devolução) **não** foram migrados nesta Sprint.

---

## 8. Arquivos

| Arquivo | Papel |
|---|---|
| `empresaContexto.js` | Resolver/validar empresa + compat explícita |
| `estoqueSaldosPublico.js` | Porta de saldos |
| `reservasPublico.js` | Porta de reservas (+ `criarReservaNaoFiscal`) |
| `index.js` | Fachada única |
| `MtsService.js` | Propaga `empresaId` (ou compat) |
| `MotorComercialService.js` | Propaga contexto / compat certificada |

---

## 9. Logs

Rastreamento estruturado via `logOperacaoSaldo` (produto, empresa, operação, tipo, quantidade, usuário).

Ativar com:

```bash
CDS_LOG_SALDOS=1
```

Sem a variável, o log permanece desligado (evita ruído em testes/produção).

---

## 10. Próxima etapa recomendada

1. Redirecionar mutadores SQL diretos (compra/venda/ajuste/devolução) para a porta pública.  
2. Criar cadastro `empresas` oficial + JWT/contexto FE.  
3. Criar `estoque_empresa` e migrar saldos.  
4. Remover `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` dos fluxos que já tiverem empresa.
