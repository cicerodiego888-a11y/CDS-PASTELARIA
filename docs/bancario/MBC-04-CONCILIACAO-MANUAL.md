# MBC-04 — Conciliação bancária manual

STATUS: implementado sobre MBC-01 a MBC-03. Sem matching automático, Open Finance, OFX ou alteração do financeiro.

## 1. STATUS

Concluída. A conciliação registra apenas:

TRANSAÇÃO BANCÁRIA → CONCILIAÇÃO → REGISTRO FINANCEIRO EXISTENTE

## 2. Arquitetura

Entidade própria `conciliacao_bancaria`. Não substitui a transação nem o lançamento. Empresa via `BancarioEmpresaContextoService`. Três pontas com o mesmo `empresa_id`.

## 3. Conceito

O usuário escolhe transação e registro e confirma. O MBC grava o vínculo. Não cria receita, despesa, CR/CP, nem altera valor/status do título.

## 4. Tabela

`conciliacao_bancaria`: id, empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id, status, valor_conciliado, observacao, **ativo**, conciliado_em, desconciliado_em, timestamps.

Índice único parcial: uma conciliação **ativa** por transação.

## 5. Estados (MBC-01)

Armazenados em minúsculas: `pendente` (derivado), `conciliada`, `ignorada`, `divergente`.

**PENDENTE** não gera linha: transação sem conciliação `ativo = 1`.

**Desconciliação:** não apaga; `ativo = 0` + `desconciliado_em`. Status histórico permanece `conciliada`. A transação volta a PENDENTE.

Não foi criado status DESFEITA/CANCELADA para não quebrar o conjunto de quatro estados.

Ignorada → pendente: desconciliar o registro de ignorada (`ativo = 0`).

## 6. Empresa

`conciliacao.empresa_id` = transação = registro financeiro. Sem `empresa_id = 1`. Query/body ignorados.

`contas_receber_pagamentos` não tem `empresa_id`: empresa pela parcela (`contas_receber.empresa_id`).

Caixa físico, PIX (`pix_cobrancas`) e TEF **não** são origens nesta sprint.

## 7. Valor

`valor_conciliado > 0`.

- **FINANCEIRO:** sem saldo restante oficial → somente valor integral igual ao da transação e ao do lançamento; um vínculo ativo por lançamento (não há parcial).
- **CONTAS_RECEBER:** usa `valor_restante` oficial menos conciliações MBC ativas; parcial permitida se `valor_conciliado ≤ min(transação, disponível)`. O `valor_restante` **não** é atualizado pelo MBC.
- **CONTAS_RECEBER_PAGAMENTO:** identidade do pagamento (`valor_pago`); somente match integral; empresa via join.

Diferença de valor: 409 `Os valores não são compatíveis para conciliação.` Sem ajuste automático.

## 8. Direção

ENTRADA → `financeiro.tipo = receita` ou contas a receber/pagamento.  
SAIDA → `financeiro.tipo = despesa`.  
TRANSFERENCIA → recusa: `Não foi possível validar a compatibilidade financeira da transação.`

Datas diferentes não bloqueiam. Descrição não faz matching.

## 9. Desconciliação

`POST /conciliacoes/:id/desconciliar`. Preserva histórico. Sem DELETE.

## 10. Histórico

Nova conciliação após desfazer é permitida (índice só em `ativo = 1`). O vínculo antigo permanece consultável.

## 11. APIs

Recurso principal `/api/bancario/conciliacoes`:

- GET lista (filtros: conta, transação, status, origem, período)
- GET `:id`
- POST criar (vínculo manual)
- POST `:id/desconciliar`

Atalhos: `POST /transacoes/:id/ignorar`, `POST /transacoes/:id/divergente`.

`GET /conciliacoes?status=PENDENTE` lista transações sem conciliação ativa.

`GET /conciliacoes/registros-elegiveis?direcao=` consulta títulos da empresa (somente leitura).

Permissão `financeiro`. Sem SQL na rota.

## 12. UI

Financeiro → Contas Bancárias → Transações: status, Conciliar / Ignorar / Divergente / Desconciliar. Modal mostra transação, registro, valores e diferença; só concilia ao confirmar. `cds-empresa-contexto-alterado` limpa seleção e recarrega.

## 13. Segurança

404 fora do contexto. 403 sem autorização. 409 segunda conciliação ativa.

## 14. Integração com financeiro

Somente SELECT. Nenhuma atualização de valor, status, vencimento, pagamento ou recebimento.

## 15. Não implementado

Open Finance, OAuth, OFX, sync, matching, IA, conciliação PIX/TEF, DRE, MIS, MUC, PDV, vendas, compras, caixa, criação de títulos, transferência entre contas, provider.

## 16–21

Ver `IMPLEMENTACAO_MBC_04_RELATORIO.md`.

Recomendação: MBC-05 — Provider/Adaptador Bancário + Política de Secrets.
