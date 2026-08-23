# Relatório — Sprint 04.04
## Reserva multiempresa do atendimento (MUV)

**Data:** 2026-08-22 · **Status:** concluída (reserva + cancelamento; sem pagamento)

### Decisão

O atendimento `VALIDADO` passa a reservar estoque de forma atômica por operação empresarial, reutilizando `reservasPublico` (dual-write 03.20). A origem da reserva fica em `atendimento_operacao_reservas`. Não foi criado motor paralelo nem `ReservaAtendimentoService`.

`EMPRESA_UNICA` permanece no fluxo legado.

### Arquivos criados

- `tests/muv/reserva-atendimento-multiempresa-04-04.test.js`
- `docs/arquitetura/IMPLEMENTACAO_04_04_RESERVA_ATENDIMENTO_MULTIEMPRESA.md`
- `docs/arquitetura/IMPLEMENTACAO_04_04_RELATORIO.md`

### Arquivos alterados

- `backend/motores/muv/contratos.js` — `RESERVADO` / `RESERVADA` / `STATUS_RESERVA_ATENDIMENTO` / fluxos 04.04
- `backend/motores/muv/atendimentoSchema.js` — tabela `atendimento_operacao_reservas`
- `backend/motores/muv/AtendimentoMultiempresaService.js` — `reservarAtendimento`, `cancelarAtendimento`
- `backend/motores/muv/index.js` — comentário do módulo

`database.js` já bootstrapa `garantirSchemaAtendimento` (passa a criar a nova tabela).

### Schema

`atendimento_operacao_reservas` (rastreio). Reserva física continua em `reservado_*` via porta pública.

### Fluxo real

`VALIDADO` → TX `BEGIN IMMEDIATE` → reserva por `empresa_id` da operação → `RESERVADO` / `pagamento_pendente: true` / `venda_concluida: false`.

`RESERVADO` → cancelar → liberação atômica → `CANCELADO`.

### Atomicidade

Rollback total se qualquer operação falhar. Sem reserva parcial entre empresas. Sem órfãos.

### Idempotência

Re-reserva em `RESERVADO` é no-op seguro. Re-cancelamento devolve `RESERVA_JA_LIBERADA`. Cancelado não volta a reservar (`ATENDIMENTO_CANCELADO`).

### Isolamento

Autoridade = `atendimento_operacoes.empresa_id`. Sem fallback para estoque global / empresa 1 / CNPJ.

### EMPRESA_UNICA

Inalterado.

### MULTIEMPRESA

Não cria `vendas`. Não chama `VendaPagamentoService`. Não consome reserva.

### Testes novos

`tests/muv/reserva-atendimento-multiempresa-04-04.test.js` — **27/27**

### Regressão

| Suite | Resultado |
|---|---|
| atendimento-multiempresa-04-03 | 25/25 |
| modo-operacao-venda-04-02 | 14/14 |
| motor-universal-vendas-04-01 | 10/10 |
| reservas-dual-write-empresa | 12/12 |
| reservas-pdv-multiempresa-contexto | 10/10 |
| pedido-disponibilidade-multiempresa | 4/4 |
| pedido-mts-disponibilidade-multiempresa | 5/5 |
| mts-multiempresa-contexto | 10/10 |
| porta-publica-saldos-multiempresa | 17/17 |
| consulta-saldo-porta-multiempresa | 12/12 |
| venda-baixa-empresa-contexto | 12/12 |
| compras-multiempresa-contexto | 12/12 |
| credito-cancel-dev-venda-porta-publica | 12/12 |
| revert-devolucao-venda-porta-publica | 10/10 |
| muc-public-contract | 20/20 |

### Limitações

Sem pagamento, TEF, PIX, cartão, caixa, `vendas`, NFC-e, XML, comprovante unificado, UI, consumo definitivo.

Dois previews `VALIDADO` ainda podem coexistir; só a **reserva** serializada (`BEGIN IMMEDIATE`) impede ultrapassar o saldo.

### Próxima Sprint

**04.05** — pagamento unificado / preparação de rateio. Sem comprovante visual ainda, salvo decisão explícita.
