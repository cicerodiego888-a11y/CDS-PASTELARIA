# Implementação 04.10 — Comprovante Unificado de Atendimento

**Status:** concluída · **Somente leitura** · **Sem impressão física** · **04.11 não iniciada**

## Objetivo

Montar UM DTO oficial do atendimento MULTIEMPRESA a partir dos dados persistidos, pronto para futura impressão, sem emitir NFC-e nem alterar estoque/pagamento/vendas.

## Fontes oficiais

| Seção | Tabela |
|---|---|
| Cabeçalho / total | `atendimentos` |
| Itens (ordem `id`) | `atendimento_operacao_itens` |
| Pagamento unificado | `atendimento_pagamentos` |
| Documentos | `atendimento_operacao_documentos` (só se `empresa_id`/`venda_id` batem com a operação) |
| Nome da empresa | `empresas` |
| Descrição do item | `produtos.nome` (se existir) |

Não lê `configuracoes` globais, CSC, certificado ou body/query.

## Contrato (evolução 04.07)

Mantido: `tipo`, `cabecalho`, `itens` (sem `empresaId`), `itensAgrupadosPorEmpresa`, `total`, `pagamento.unificado`, `documentosFiscais`, `invariantes`.

Acrescentado: `atendimento`, `estabelecimento`, `totais`, `pagamentos`, `documentos_fiscais`, `fiscal`, `renderizacao`.

Itens em lista contínua por `itemId`. Rateios não aparecem. QR/chave só se persistidos.

## Estados

Leitura permitida em VALIDADO, RESERVADO, PAGO, CONCLUIDO, FISCALIZADO, FISCAL_PARCIAL, FISCAL_ERRO, CANCELADO. Sem documentos → `fiscal.status = PENDENTE`. Parcial não oculta autorizadas.

## Endpoint

`GET /api/atendimentos/:id/comprovante` (`verificarToken`). Router só valida e delega.

## Segurança / imutabilidade

Serviço sem INSERT/UPDATE/DELETE. Sem CSC/senha/PFX. EMPRESA_UNICA / PDV intactos.
