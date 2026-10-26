# MCF-02.1 — Estratégia de reconciliação histórica (sem backfill)

**Escopo:** obrigações de Contas a Pagar existentes em `financeiro` antes do MCF.  
**Nesta etapa:** apenas estratégia e critérios. **Não** executar backfill, migração persistente nem alteração de dados reais.

## 1. Universo candidato

Registros em `financeiro` onde:

- `tipo = 'despesa'`
- `origem` **não** é `mcf_compatibilidade`
- `referencia_tipo` **não** é `contas_pagar_mcf`
- Preferência por origens de AP: `compra`, `manual` (despesa), eventuais categorias de fornecedor/despesa operacional

Excluir explicitamente:

- `tipo = 'receita'` e Contas a Receber
- Movimentações de caixa/sangria/suprimento de outra natureza
- Projeções já vinculadas em `contas_pagar_financeiro_compat`

## 2. Critérios de correspondência (automática)

Ordem sugerida (maior confiança → menor):

| Prioridade | Chave | Condição |
|------------|-------|----------|
| 1 | Compra + parcela | `origem='compra'` + `compra_id` + `numero_parcela` + `empresa_id` casa com `contas_pagar.referencia_tipo='compra'` + `referencia_id` + `numero_parcela` |
| 2 | Documento + valor + vencimento | mesmo `empresa_id`, `documento` não nulo, `valor` ≈ `valor_original` (±0,01), `vencimento` = `data_vencimento` |
| 3 | Fornecedor + valor + data | `pessoa_nome` / fornecedor + valor + data emissão/vencimento |

Só aceitar match **1:1**. Se um financeiro casar com N títulos (ou o inverso), marcar **ambíguo**.

## 3. Pagamentos e status existentes

| Situação legado | Tratamento proposto (futuro backfill) |
|-----------------|----------------------------------------|
| `pendente` / aberto | Criar título MCF `aberto` com `valor_restante = valor` e projeção (ou vínculo ao registro existente) |
| `parcial` | Criar título + pagamento(s) sintéticos até o saldo residual documentado |
| `pago` / `recebido` | Criar título `quitada` + pagamento total; ou apenas vínculo histórico sem reabrir obrigação |
| `cancelado` | Criar título `cancelada` ou registrar como histórico sem obrigação ativa |

Pagamentos já refletidos só no legado (sem linha em `contas_pagar_pagamentos`) devem gerar lançamentos MCF de pagamento com `origem_operacao = 'reconciliacao_historica'` e chave de idempotência estável (`hist:fin:{id}:pag:{n}`).

## 4. Divergências e casos manuais

Classificar e **não** auto-migrar:

- Valor ou vencimento divergente após match por compra/parcela
- Mais de um `financeiro` para a mesma parcela de compra
- Título MCF já existente sem vínculo de compat e financeiro legado paralelo (risco de dupla obrigação)
- Empresa_id nulo ou inconsistente
- Despesas manuais sem documento/fornecedor identificável

Saída operacional: relatório CSV/JSON com `financeiro_id`, candidato(s) MCF, score, `acao_sugerida` (`vincular` | `criar_titulo` | `ignorar` | `revisao_manual`).

## 5. Identidade do vínculo

Ao reconciliar (etapa futura):

- Usar `contas_pagar_financeiro_compat` (`UNIQUE (empresa_id, conta_pagar_id)` e `UNIQUE (empresa_id, financeiro_id)`)
- Preferir **vincular** o registro histórico existente como projeção (atualizar `origem`/`referencia_tipo` sob controle) em vez de inserir segunda linha em `financeiro`
- Nunca criar segunda obrigação ativa para o mesmo fato econômico

## 6. Fora de escopo agora

- Backfill em banco de produção/homologação
- Alteração do matching MBC
- Remoção de APIs/tabelas legadas
- Declaração de conclusão do MCF-02 / Sprint 03
