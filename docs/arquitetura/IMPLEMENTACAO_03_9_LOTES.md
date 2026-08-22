# Implementação 03.9 — Lotes → contexto / porta existente

**Status:** concluída (sem migração) · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Conclusão da auditoria

O módulo de lotes **não é um escritor pendente de saldo/reserva**.

Os métodos vivos só gravam rastreabilidade em `produtos_lotes` / `venda_lotes`.
O saldo operacional de `produtos` continua nas portas já migradas (compra, venda,
ajuste, CREATE 03.8).

Não foi criada porta. Não foi criado `COMPAT_LOTES_PRE_MULTIEMPRESA`.
Não foi criado `estoque_empresa`. **Parada aqui.**

---

## Serviço principal

`backend/services/lotesService.js`

`db` global (`require('../database')`). Sem `empresaId` no fluxo.

Não usa `estoqueSaldosPublico` nem `reservasPublico` — e não precisa, porque
não escreve saldo/reserva operacional nos métodos chamados.

---

## Escritas encontradas

| Método | Tabela | Efeito | Tipo |
|---|---|---|---|
| `criarLote` | `produtos_lotes` INSERT | rastreio de validade | não é saldo |
| `consumirLotesFEFO` | `produtos_lotes` UPDATE `quantidade_atual −` | FEFO | não é saldo |
| `registrarConsumoVenda` | `venda_lotes` INSERT | vínculo venda↔lote | não é saldo |
| `restaurarLotesVenda` | `produtos_lotes` UPDATE `quantidade_atual +` | cancelamento | não é saldo |
| `atualizarEstoqueConsolidado` | `produtos` SET `estoque_atual = somaLotes` | **latente** | ver abaixo |

Nenhum método vivo escreve `saldo_fiscal`, `saldo_nao_fiscal`,
`reservado_fiscal` ou `reservado_nao_fiscal`.

---

## `atualizarEstoqueConsolidado` — não migrável pela porta

SQL:

```sql
UPDATE produtos
SET estoque_atual = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?
```

Parâmetro: soma de `produtos_lotes.quantidade_atual` (ativos).

- **Não** altera SF/SNF.
- Emite `console.warn` se `somaLotes ≠ SF+SNF`.
- **Não possui caller** no backend (só export).
- A porta (`creditarSaldo` / `debitarSaldo`) sempre escreve SF, SNF e
  `estoque_atual = SF+SNF`. Um SET absoluto de EA pela soma de lotes **não**
  tem operação equivalente. Mapear o delta para F ou NF inventaria distribuição.

Regra da Sprint: não inventar. Registrar e parar.

---

## empresaId / COMPAT / transação

Não aplicáveis — não houve escrita migrada.

---

## Callers de lotes (saldo já na porta do caller)

| Caller | O que o lote faz | Saldo |
|---|---|---|
| `rotas/compras.js` | `criarLote` | crédito 02.x |
| `VendaPagamentoService` | FEFO + `venda_lotes` | débito 02.6 |
| `ajusteEstoqueService` | criar/consumir lote | porta 02.1 |
| `rotas/produtos.js` POST | lote inicial | CREATE 03.8 |
| Devolução venda | `restaurarLotesVenda` | porta 02.5 / 03.5 |

---

## Teste

`tests/estoque/lotes-porta-publica.test.js` — auditoria mínima (sem cenário inventado de crédito).

---

## Próximo passo

**Não** avançar para `estoque_empresa` nesta Sprint.
