# MBC-07 — Sincronização de saldo e extrato

Sincronização homologada em **MOCK**. Não é conexão bancária real.

## Arquitetura

```
EMPRESA → CONTA → CONFIG → CONSENTIMENTO AUTORIZADO → PROVIDER
  → DTO TransacaoBancariaNormalizada → Motor → MBC-03 → transacao_bancaria
```

O provider **nunca** faz INSERT em `transacao_bancaria`.

## Pré-condições

Conta existente, da empresa, ativa; configuração ativa; provider no registry com `suportaSincronizacao`; consentimento AUTORIZADO (via `exigirConsentimentoAutorizado()`). Qualquer falha: não sincroniza.

## Saldo

`saldo_bancario` = informado pelo provider (persistido em `sincronizacao_bancaria`).  
`saldo_conceitual` = MBC-03 (entradas − saídas).  
`diferenca` = bancário − conceitual (somente apresentação). Sem conciliação automática.

## Extrato

Páginas do provider → normalização → `TransacaoBancariaService.registrar`. Sem edição na UI.

## APIs

- `POST /api/bancario/contas/:id/sincronizar`
- `GET /api/bancario/contas/:id/sincronizacao`
- `GET /api/bancario/contas/:id/saldo-bancario`
- `GET /api/bancario/contas/:id/extrato`

Contexto oficial. Sem autoridade de `empresa_id` no cliente.

## O que não foi feito

Conciliação automática, matching, IA, lançamentos financeiros, vendas, compras, caixa, PDV, provider real.
