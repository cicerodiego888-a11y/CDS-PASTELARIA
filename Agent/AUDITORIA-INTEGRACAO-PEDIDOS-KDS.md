# AUDITORIA — Integração Pedidos → KDS

**Data:** 2026-11-17  
**Caso:** `PED-1794968555052` aparece em Pedidos e não no KDS (nenhuma unidade)  
**Modo:** SOMENTE DIAGNÓSTICO — nenhum arquivo de produto alterado para correção; sem insert/update/delete; sem banco oficial; sem S07-3

---

## Veredito

**Não há integração efetiva entre a criação/envio do pedido no ERP e a fila operacional do KDS.**

O KDS **só** lê `cozinha_rodadas` + `cozinha_itens` produzidos por `POST /api/cozinha/despacho` (`CozinhaDespachoService.despacharLote`).  
Criar pedido em Pedidos e até o botão **“Enviar pedido para cozinha”** **não** chamam esse despacho: gravam apenas o domínio comercial / `pedido_preparacoes`.

Por isso `PED-1794968555052` (e qualquer pedido criado só pelo ERP) **não aparece em nenhuma unidade** — não existe registro operacional de cozinha para ele.

Isso já estava documentado no planejamento S07 (`Agent/PLANEJAMENTO-SPRINT07-KDS.md` §1.3) e no relatório S07-1.

---

## 1. Fluxo real — criação do pedido (comercial)

| Etapa | Onde |
|-------|------|
| UI | `frontend/erp/js/pedidos.js` → `POST /api/pedidos` |
| Rota | `backend/rotas/pedidos.js` |
| Serviço | `PedidoOperacionalService.criar` |
| Persistência | Tabelas `pedidos` + itens comerciais (`pedidos_itens` / fluxo associado) |
| Preparação ERP (ao criar no salão) | `PedidoPreparacaoService.registrarNaoEnviado` → `pedido_preparacoes` estado `NAO_ENVIADO` |

**Não grava** em `cozinha_rodadas` / `cozinha_itens`.  
**Não define** `unidade_cozinha_id` nos itens do pedido comercial.

---

## 2. Fluxo “Enviar pedido para cozinha” (ERP — não é KDS)

| Etapa | Onde |
|-------|------|
| UI | `frontend/erp/js/mesas-conferencia.js` — botão `data-acao="enviar"` |
| Rota | `POST /api/pedidos/:id/preparacao/enviar` |
| Serviço | `PedidoPreparacaoService.enviar` |
| Efeito | `pedido_preparacoes.estado = 'EM_PREPARACAO'` + `enviado_em` |

Comentário explícito no próprio serviço e na UI:

> *Não há fila de cozinha, impressão nem status comercial representando o envio.*  
> *Não confirma recebimento por cozinha, impressora ou KDS.*

**Fila de impressão S06** (`CozinhaImpressaoFilaService`) também **não** é acionada por Pedidos/conferência — só a partir do despacho Cozinha (ou testes).

---

## 3. Fluxo real — entrada no KDS (operacional)

| Etapa | Onde |
|-------|------|
| Abastecimento | `POST /api/cozinha/despacho` → `CozinhaDespachoService.despacharLote` |
| Exige | `empresaId`, `unidade_id`, `mesa_id`, `atendimento_id`, itens com `pedido_id` / `pedido_item_id` / `comanda_id`, `Idempotency-Key` |
| Persistência | `cozinha_comandas`, `cozinha_rodadas`, `cozinha_itens` (+ outbox/notificações / opcional fila impressão S06) |
| Consulta KDS | `GET /api/cozinha/preparacao/painel` → `CozinhaKdsPainelService.listarPainelPreparacao` |
| Filtros KDS | `r.empresa_id` + `r.unidade_id` (= JWT `unidade_cozinha_id` via S07-2) |
| UI | `frontend/erp/js/cozinha-kds.js` — poll 5s sobre o painel |

Quem chama `despacharLote` hoje no repositório: **rotas Cozinha + testes/harness** — **nenhum** `frontend/erp/js/pedidos.js`, `mesas-lancamento.js` ou `mesas-conferencia.js`.

---

## 4. Separação de responsabilidades (não confundir)

| Conceito | Tabela / API | Ligado a Pedidos? | Ligado ao KDS? |
|----------|--------------|-------------------|----------------|
| Registro comercial | `pedidos` / itens | Sim | Não |
| Relógio preparação ERP | `pedido_preparacoes` + `/preparacao/enviar` | Sim | **Não** |
| Fila produção KDS | `cozinha_rodadas` / `cozinha_itens` + `/cozinha/despacho` | Só se despachar | **Sim** |
| Fila impressão S06 | `cozinha_impressao_*` | Só via despacho Cozinha | Paralela ao KDS |

---

## 5. Unidade de cozinha nos itens

- Itens comerciais do pedido: **sem** coluna/campo de unidade de cozinha no fluxo Pedidos.
- Unidade entra **somente** no despacho (`unidade_id` no lote) e fica gravada em `cozinha_*`.
- KDS filtra pela unidade do JWT; se não houver despacho, filtrar outra unidade **não muda nada** — não há linhas.

---

## 6. Condições de status / origem

Mesmo com status `PEDIDO` / `ABERTO` / `EM_SEPARACAO` (despacháveis no `CozinhaDespachoService`), **nada no ERP dispara o despacho automaticamente**.  
Origem Mesa/Pedidos e status compatível **não bastam** para o KDS.

---

## 7. Empresa e unidade

- Pedidos e KDS usam o mesmo mecanismo de contexto (`X-Empresa-Id` / middleware empresa).
- Isolamento S07-2 do KDS está coerente: painel = empresa do contexto + unidade do JWT.
- O caso `PED-1794968555052` falha **antes** do filtro de unidade: **ausência de registro em `cozinha_*`**.

---

## 8. Logs / erros silenciosos

Não há erro silencioso típico no caminho Pedidos → KDS porque **esse caminho não existe**.  
O operador pode ver sucesso em “Enviar pedido para cozinha” (ERP) e interpretá-lo como envio ao KDS — a própria UI diz que **não** confirma KDS.

---

## Ponto exato da falha de integração

```
Pedidos.criar / Conferencia.enviar
        │
        ▼
 pedido + pedido_preparacoes     ←── para aqui (ERP)
        │
        ✕  (não chama)
        │
        ▼
 POST /api/cozinha/despacho
        │
        ▼
 cozinha_rodadas / cozinha_itens
        │
        ▼
 GET /api/cozinha/preparacao/painel  →  KDS
```

**Ponto de quebra:** ausência de orquestração ERP → `CozinhaDespachoService.despacharLote` após criação ou após “enviar para cozinha”.

---

## Por que não aparece em nenhuma unidade

1. Não há `cozinha_itens` / `cozinha_rodadas` para o pedido.  
2. Trocar unidade no KDS só muda o filtro; o conjunto de produção continua vazio para esse pedido.  
3. Independente de `PED-1794968555052` estar visível e válido em Pedidos.

---

## Correção recomendada (NÃO IMPLEMENTAR NESTA ETAPA)

Sob brief PO/TL (candidato natural a **S07-3** ou gancho autorizado):

1. Após sucesso de `PedidoPreparacaoService.enviar` (ou ato explícito “Despachar para KDS”), montar lote e chamar `CozinhaDespacho.despacharLote` com:
   - `unidade_id` resolvida (sessão KDS / cadastro / regra de roteamento — a definir);
   - `mesa_id`, `atendimento_id`, itens (`pedido_id`, `pedido_item_id`, `comanda_id`);
   - `Idempotency-Key` estável por envio.
2. Garantir criação/uso de comanda Cozinha alinhada ao despacho.
3. Não misturar com fila de impressão S06 além do que o despacho já faz.
4. Manter S06 / S07-1 / S07-2 intactos (despacho e painel já existem; falta o gancho).
5. Atualizar copy da UI: “Enviado para preparação (ERP)” ≠ “Enviado ao KDS” até o gancho existir.

**Alternativa mínima de homologação:** chamada manual/controlada a `POST /api/cozinha/despacho` (já usada nos testes) — não resolve o fluxo do operador no ERP.

---

## Arquivos-chave

| Papel | Arquivo |
|-------|---------|
| Criar pedido | `backend/services/pedido/PedidoOperacionalService.js`, `backend/rotas/pedidos.js`, `frontend/erp/js/pedidos.js` |
| Preparação ERP | `backend/services/pedido/PedidoPreparacaoService.js`, `mesas-conferencia.js` |
| Despacho KDS | `backend/services/cozinha/CozinhaDespachoService.js`, `POST /api/cozinha/despacho` |
| Painel KDS | `CozinhaKdsPainelService.js`, `GET /preparacao/painel`, `cozinha-kds.js` |
| Doc prévia da lacuna | `Agent/PLANEJAMENTO-SPRINT07-KDS.md`, `Agent/RELATORIO-SPRINT07-S07-1.md` |

---

**S07-3 não iniciado. Nenhuma correção aplicada. Banco oficial não acessado.**
