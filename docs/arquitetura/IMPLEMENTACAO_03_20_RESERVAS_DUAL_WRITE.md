# Implementação 03.20 — dual-write de reservas

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Porta

`backend/services/fiscalNaoFiscal/reservasPublico.js`

Métodos: `reservarQuantidade` / `liberarQuantidadeReservada` → `ajustarReservado`.

Callers (PDV 02.7, Repair 03.7, consumo 03.6) não foram reescritos.

---

## Com empresaId

Após atualizar `produtos.reservado_*`, `EstoqueEmpresaService.aplicarEfeitoReservado` aplica o mesmo delta.

Não altera `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`.

---

## Sem empresaId

COMPAT: só `produtos`. Não cria `estoque_empresa`.

---

## Registro inexistente

Nasce zerado + delta atual. Não copia reservado legado.

---

## Isolamento / rollback

A e B independentes. Mesmo `db`; rollback externo desfaz as duas escritas.

---

## Leitura

`consultarDisponibilidade` continua em `produtos`. `estoque_empresa` ainda não é fonte operacional.
