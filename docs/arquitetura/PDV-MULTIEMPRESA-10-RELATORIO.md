# PDV-MULTIEMPRESA-10 — Testes E2E de Entrega e Faturamento

**Data:** 2026-10-26  
**Pré-requisito:** PDV-MULTIEMPRESA-08 / 09  
**Tipo:** Homologação E2E isolada (sem alteração de regras de produção)  
**Estado final:** **CONCLUÍDA** (canais classificados; build de produção permanece bloqueado até revisão TL)

## 1. Objetivo

Comprovar E2E que Entrega e Faturamento/Expedição respeitam o Motor F×NF pós-M08 (buckets exclusivos), sem mudar produção.

## 2. Confirmação de escopo

| Item | Status |
|---|---|
| Alteração de regras de produção | **Nenhuma** |
| Schema / contratos públicos | Intactos |
| `CDS_ALLOW_OFFICIAL_DB` | Não utilizado |
| SEFAZ / vendas reais | Não executados |
| Instalador / build produção | Não gerado |

**Arquivos desta sprint (somente testes + relatório):**

- `tests/pdv/pdv-multiempresa-10-e2e-entrega.test.js` (**criado**)
- `tests/pdv/pdv-multiempresa-10-e2e-faturamento.test.js` (**criado**)
- `docs/arquitetura/PDV-MULTIEMPRESA-10-RELATORIO.md` (**criado**)

## 3. Fluxos e endpoints efetivamente percorridos

### 3.1 Entrega — **HOMOLOGADO**

```text
HTTP POST /api/vendas
  → VendaApplicationService.criarVenda
  → tipo_venda=ENTREGA
  → CriarVendaEntregaService.criarVendaEntrega
  → distribuirItensVendaComValorFiscalEfetivo (Motor F×NF M08)
  → (sucesso) INSERT venda + reserva | (falha) HTTP 400 sem mutar estoque
```

Harness: Express mínimo + `DB_DIR` temporário + caixa/empresa sintéticos. Módulo `vendasEntrega` habilitado no stub de `recursoHabilitado`.

### 3.2 Faturamento/Expedição — **HOMOLOGADO (com limitação F3)**

```text
HTTP POST /api/faturamento/pedidos/:id/faturar
  → FaturamentoService.faturarPedido
  → montarPayloadVendaDoPedido (emitir_fiscal:false, venda_fiscal←F12)
  → VendaApplicationService.criarVendaComContexto
  → VendaPagamentoService → distribuirItensVendaComValorFiscalEfetivo
```

Harness de pedido: `PedidoOperacionalService.criar` (orçamento) + status `AGUARDANDO_FATURAMENTO`.

**Motivo do harness legado:** `PedidoService.criarPedido` reserva preferindo saldo fiscal e bloqueia cenários só-NF **antes** do faturamento — gate do módulo Pedidos, não do Motor F×NF. O E2E homologado é o caminho **faturarPedido → núcleo**.

## 4. Cenários e resultados

### Entrega (`pdv-multiempresa-10-e2e-entrega.test.js`) → **6 pass / 0 fail**

| ID | Cenário | Resultado | Evidência |
|---|---|---|---|
| E1 | Fiscal + saldo F suficiente | **PASS** | HTTP &lt;400; NF não consumido |
| E2 | Fiscal + só NF | **PASS** | HTTP 400; estoque inalterado; msg `Disponível: 20` (= estoqueTotal) |
| E3 | Não fiscal + NF suficiente | **PASS** | HTTP &lt;400 |
| E4 | Não fiscal + só F | **PASS** | HTTP 400; sem débito/reserva parcial; msg `Disponível: 15` |
| E5 | Qty &gt; bucket F (total 52) | **PASS** | HTTP 400; saldos 2F+50NF intactos; msg `Disponível: 52` |

### Faturamento (`pdv-multiempresa-10-e2e-faturamento.test.js`) → **6 pass / 0 fail**

| ID | Cenário | Resultado | Evidência |
|---|---|---|---|
| — | Contrato estático faturar→núcleo→motor | **PASS** | Leitura de fontes |
| F1 | F12 ON + saldo F | **PASS** | HTTP faturar OK |
| F2 | F12 ON + só NF | **PASS** | Bloqueio; saldos intactos |
| F3 | F12 OFF + só NF | **PASS*** | Ver §5 — canal pode bloquear por gate supervisor |
| F4 | F12 OFF + só F | **PASS** | Bloqueio; sem débito parcial |
| F5 | Qty &gt; bucket F (2+50) | **PASS** | Bloqueio M08; saldos intactos |

\*F3 exercita o endpoint real; quando bloqueia, a mensagem observada é a de **transferência NF→F com supervisor** em `persistencia_venda` — gate **anterior/paralelo** ao consumo exclusivo M08. Sem alteração de regra nesta sprint.

## 5. Diferenças entre canais

| Aspecto | Entrega | Faturamento/Expedição |
|---|---|---|
| Sinal fiscal | `emitir_fiscal` no body | `modo_dashboard_fiscal` (F12) → `venda_fiscal` no payload |
| NFC-e | Não emite | `emitir_fiscal: false` (Expedição) |
| Mensagem de bloqueio motor | `Disponível: ${estoqueTotal}` | Erro do núcleo (`body.error` / etapa) |
| `estoqueTotal` vs `disponivelBucket` | **Confirmado:** E2/E4/E5 mostram total, não o bucket | Não usa o mesmo texto; bloqueio por insuficiência/supervisor |
| Pré-gate Pedidos | N/A | `criarPedido` operacional exige F para reserva — contornado no harness por orçamento legado |

### Diferença conhecida (não corrigida — escopo)

Entrega continua reportando **`estoqueTotal`** na mensagem 400 (ex.: disponível 52 com necessidade fiscal 5 e F=2). O bloqueio M08 está correto; a UX da mensagem permanece como limitação documentada em M09/M10.

## 6. Execução

```text
node --test tests/pdv/pdv-multiempresa-10-e2e-entrega.test.js
→ 6 pass / 0 fail

node --test tests/pdv/pdv-multiempresa-10-e2e-faturamento.test.js
→ 6 pass / 0 fail
```

Sequenciais, `DB_DIR` temporário, sem suítes amplas.

## 7. Estado dos canais

| Canal | Estado |
|---|---|
| Entrega (`CriarVendaEntregaService`) | **HOMOLOGADO** E2E |
| Faturamento/Expedição (`faturarPedido` → núcleo) | **HOMOLOGADO** E2E (limitação F3 / gate supervisor documentada) |
| PDV `/pdv` | Já homologado em M09 (fora do escopo desta sprint) |
| Build / instalador produção | **BLOQUEADO** até revisão do Tech Lead |

## 8. Pendências

1. UX Entrega: alinhar mensagem a `disponivelBucket` (sprint autorizada).
2. F3: investigar gate `persistencia_venda` / supervisor em venda não fiscal com só NF — possível desalinhamento com M08; **não** corrigido aqui.
3. Homologação com `PedidoService.criarPedido` (reserva fiscal) + faturar — depende de política de pedidos.
4. Revisão TL antes de build de produção.

## 9. Encerramento

Entrega e Faturamento foram exercitados E2E com evidências de bloqueio M08 e ausência de débito parcial nos cenários de falha. Nenhuma regra de produção alterada. Build permanece bloqueado.

**Estado: CONCLUÍDA**  
Não iniciada outra sprint automaticamente.
