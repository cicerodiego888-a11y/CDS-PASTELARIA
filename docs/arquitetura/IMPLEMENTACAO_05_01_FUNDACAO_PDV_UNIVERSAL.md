# Implementação 05.01 — Fundação do PDV Universal

**Status:** concluída · **Sem nova tela** · **Sem checkout MULTIEMPRESA HTTP**

## Ponto oficial

`backend/motores/pdv-universal/` — camada de aplicação acima de:

- EMPRESA_UNICA → `VendaApplicationService` (`EmpresaUnicaAdapter`)
- MULTIEMPRESA → `AtendimentoMultiempresaService` (`MultiempresaAdapter`)

Não é um terceiro motor. Não acessa estoque, TEF, NFC-e ou rateio.

## Resolução de modo

Somente `resolverModoOperacaoVendaAtivo()` / `configuracaoService.obterModoOperacaoVenda`.  
Inválido → `MODO_OPERACAO_VENDA_INVALIDO`. Sem fallback silencioso.

## Contrato de contexto

```json
{
  "camada": "PDV_UNIVERSAL",
  "modo_operacao": "EMPRESA_UNICA | MULTIEMPRESA",
  "contexto": {
    "operador_id": 1,
    "terminal_id": null,
    "empresa_id": null,
    "empresas_disponiveis": []
  },
  "capacidades": {
    "multiempresa": false,
    "atendimento": false,
    "pagamento_unificado": false,
    "fiscalizacao_por_empresa": false,
    "comprovante_unificado": false
  }
}
```

`empresa_id` nulo é válido nesta sprint (seleção na 05.02). Nunca assume empresa 1.

## HTTP

`GET /api/pdv-universal/contexto` (`verificarToken`). Somente leitura. Sem config fiscal.

## PDV atual

`POST /api/vendas` e o frontend do PDV permanecem. Sem troca visual.
