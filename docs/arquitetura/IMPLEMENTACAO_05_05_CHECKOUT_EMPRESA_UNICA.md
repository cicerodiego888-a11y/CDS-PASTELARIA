# Implementação 05.05 — Checkout EMPRESA_UNICA

**Status:** concluída · **Sem checkout MULTIEMPRESA** · **Sem atendimento oculto**

## Fluxo

```
PDV Universal
  → POST /api/pdv-universal/checkout
  → finalizarCheckout
  → validar carrinho (uma empresa = contexto)
  → PDVUniversalVendaAdapter
  → EmpresaUnicaAdapter → VendaApplicationService.criarVenda
  → VendaPagamentoService / Orquestrador / TEF / fiscal existentes
```

MULTIEMPRESA → `CHECKOUT_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO` (não chama o legado).

## TEF

O PDV Universal **não** chama `POST /api/tef/pagar`. O TEF permanece no núcleo oficial após `criarVenda`. Formas cartão/PIX seguem o mesmo caminho do PDV legado. Limitação: a UI Universal desta sprint envia a forma; o diálogo TEF do PDV legado não foi copiado.

## Idempotência

Chave `idempotency_key` na camada de checkout (não altera o PDV legado).

## Capabilities

`checkout_empresa_unica: true` só em EMPRESA_UNICA. `checkout_multiempresa: false` até a 05.06.
