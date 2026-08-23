# Implementação 04.08 — Contexto fiscal multiempresa + materialização fiscal

**Status:** concluída · **Pré-requisito:** 04.07 · **Não inclui:** impressão, cancelamento fiscal, UI, 04.09

## 1. Antes / depois

| Antes | Depois |
|---|---|
| `getFiscalConfig()` lê só `configuracoes` globais | Com `empresaId`, lê `empresas_configuracao_fiscal` + cadastro `empresas` |
| `incrementaNumeroFiscal()` usa MAX de todas as `nfce_notas` | Com `empresaId`, MAX filtrado por `nfce_notas.empresa_id` e `numero_atual` da empresa |
| Materialização sem `quantidade_fiscal` / `valor_fiscal` | Venda materializada leva fatias F/NF do item/reserva |
| `emitirPorVendaId(vendaId)` | Overload `emitirPorVendaId(vendaId, { empresaId })`; legado intacto |

## 2. Auditoria da configuração

Fonte oficial legado: tabela `configuracoes` (CNPJ, IE, CSC, certificado, série, `fiscal_numero_atual`, URLs SEFAZ).

Não existia config por empresa. **Não** se reutiliza `configuracoes` globais no MULTIEMPRESA (sem fallback, sem empresa 1).

Nova origem: `empresas_configuracao_fiscal` (uma linha por `empresa_id`). Identidade do emitente (CNPJ, razão, IE de cadastro) vem de `empresas`.

## 3. Fonte da empresa emissora

`atendimento_operacoes.empresa_id` + `venda_id`.  
`empresaId` no body/deps divergente → `VINCULO_FISCAL_INVALIDO`.  
Código da venda deve ser `MUV-{atendimentoId}-{operacaoId}`.

## 4. Campos fiscais materializados

Em `vendas` / `vendas_itens` (já existentes no schema oficial):

- `quantidade_fiscal`, `quantidade_nao_fiscal`
- `valor_fiscal`, `valor_nao_fiscal`
- `item_fiscal`

Origem: reserva da operação (quando houver) ou `tipoFiscal` do item. Sem tabela fiscal paralela.

Sem esses dados, a fiscalização falha com `DADOS_FISCAIS_INCOMPLETOS` **antes** da emissão externa.

## 5. Compatibilidade EMPRESA_UNICA

`getFiscalConfig()` e `incrementaNumeroFiscal()` sem `empresaId` permanecem `fonte: 'GLOBAL'`.  
`emitirPorVendaId(vendaId)` não exige atendimento/MUV.  
PDV → `VendaApplicationService` → `VendaPagamentoService` inalterado.

## 6. Numeração por empresa

Mesma série em A/B/C é permitida. Isolamento por `empresa_id` na nota e no `numero_atual` da config da empresa. Incremento global não altera o da empresa.

## 7. Integridade

- Documento persistido com `empresa_id` da operação
- Documento pré-existente com empresa divergente bloqueia
- XML/chave de teste carrega CNPJ da empresa da operação

## 8–9. Retry e parcial

Contrato 04.07 preservado: `FISCALIZADO` / `FISCAL_PARCIAL` / `FISCAL_ERRO`. Retry não reemite `AUTORIZADA`.

## 10. Limitações

- Cadastro da config por empresa ainda sem UI
- Emissor real ainda usa `database` global para carregar a venda (produção)
- Cancelamento fiscal multiempresa, impressão e certificado por UI: fora do escopo
- NFe modelo 55 / devolução continuam no `getFiscalConfig()` global

## 11. Arquivos

Criados: `empresasConfiguracaoFiscal.js`, testes 04.08, estes docs.  
Alterados: `configService.js`, `emissor.js`, `MaterializarOperacoesAtendimento.js`, `FiscalizarAtendimentoService.js`, `index.js` MUV, teste 04.07 (compatível com rejeição de `empresaId` externo).
