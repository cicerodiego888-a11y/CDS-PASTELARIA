# Implementação 03.15 — leitura controlada de estoque_empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Ponto escolhido

Não havia endpoint interno seguro (PDV, disponibilidade, baixa e reserva estão fora do escopo).

Consulta técnica isolada no serviço já existente:

`EstoqueEmpresaService.consultarSaldoTecnico`

Delega exclusivamente a `consultarSaldo` (03.12). Sem rota HTTP pública.

---

## Comportamento

Entrada: `produtoId`, `empresaId`, `db`.

- registro existe → SF, SNF, EA, RF, RNF persistidos
- inexistente → `null` (contrato 03.12)
- sem `empresaId` → `EMPRESA_OBRIGATORIA`

Não cria registro. Não faz backfill. Não consulta `produtos` como fallback. Não recalcula.

---

## Independência

Produto X / Empresa A e Produto X / Empresa B são registros distintos.

O saldo de `produtos` **não** é assumido igual ao de `estoque_empresa`.

---

## O que NÃO mudou

`estoqueSaldosPublico` continua em `produtos`. Dual-write 03.13, backfill 03.14, CREATE, compra, venda, PDV, reservas e motores intactos. Nenhum fluxo operacional depende desta leitura.
