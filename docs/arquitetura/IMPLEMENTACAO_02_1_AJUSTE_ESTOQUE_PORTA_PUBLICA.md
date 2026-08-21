# Implementação 02.1 — Ajuste de Estoque → Porta Pública

**Status:** concluída · **Data:** 2026-08-12  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## Situação anterior

`ajusteEstoqueService.aplicarAjusteEstoqueProduto` e o PUT de saldos iniciais em `rotas/produtos.js` faziam:

```sql
UPDATE produtos SET saldo_fiscal, saldo_nao_fiscal, estoque_atual ...
```

sem `empresaId` e fora de `estoqueSaldosPublico`.

---

## Situação posterior

```
Ajuste / Saldos iniciais
        ↓
estoqueSaldosPublico (creditarSaldo / debitarSaldo)
        ↓
produtos  (storage transitório — SEM estoque_empresa)
```

- Fiscal e Não Fiscal continuam separados.
- `estoque_atual` permanece `SF + SNF` (invariante da porta).
- Histórico `produtos_ajustes_estoque` preservado no ajuste.
- Saldos iniciais **não** gravam histórico (igual ao legado).

---

## empresaId

| Fonte | Uso |
|---|---|
| `opcoes.empresaId` / `empresa_id` | Preferencial |
| `req.body` / `req.user` no endpoint | Propagado por `executarAjusteEstoque` |
| Ausência no ERP atual | `COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA` (explícito) |
| `exigirEmpresa: true` | Falha com `EMPRESA_OBRIGATORIA` (contrato multiempresa) |

**Não** usa empresa 1, CNPJ de `configuracoes` nem fallback silencioso.

---

## Porta utilizada

- `consultarSaldo`
- `creditarSaldo` / `debitarSaldo` (`TipoSaldo.FISCAL` | `NAO_FISCAL`)
- Mesmo `db` do caller (compatível com TX externa da importação)

---

## Métodos

| Método | Papel |
|---|---|
| `aplicarAjusteEstoqueProduto` | Ajuste ± F/NF via porta + histórico |
| `aplicarSaldosIniciaisViaPorta` | Absoluto → deltas via porta |
| `definirSaldosIniciaisProduto` | Pure calc (sem SQL) |
| `montarOptsPortaAjuste` | empresa / COMPAT |

---

## Compatibilidade

`MOTIVO_COMPAT_AJUSTE = 'COMPAT_AJUSTE_ESTOQUE_PRE_MULTIEMPRESA'`

Usada automaticamente quando o caller ERP/importação não envia `empresaId` (JWT ainda sem empresa). Remover após cadastro `empresas` + contexto JWT.

---

## Limitações

1. Storage ainda em `produtos` — **sem isolamento físico** por CNPJ.
2. INSERT de produto novo ainda define saldos no CREATE (não é UPDATE de ajuste).
3. Outros mutadores (compra/venda/…) **não** migrados.

---

## Próximos passos

Implementação 02.2 sugerida: `recalcularSaldosProduto` ou crédito de compra — conforme ordem da auditoria pós-01.
