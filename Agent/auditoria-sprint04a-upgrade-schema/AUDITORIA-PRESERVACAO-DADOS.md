# AUDITORIA — Preservação de dados

## Método

1. Criar schema v3 limpo → degradar CHECK/meta para v2.
2. Popular todas as tabelas relevantes.
3. Registrar contagens + dump de `cozinha_idempotencia`.
4. Executar `garantirSchemaCozinha`.
5. Comparar contagens (`deepEqual`) e dump idempotência (`deepEqual`).
6. Confirmar IDs de rodada/item preservados.

## Tabelas povoadas no teste

`cozinha_unidades`, `cozinha_comandas`, `cozinha_rodadas`, `cozinha_itens`, `cozinha_item_ingredientes`, `cozinha_bebida_entregas`, `cozinha_estacoes_impressao`, `cozinha_impressao_fila`, `cozinha_notificacoes`, `cozinha_eventos_outbox`, `cozinha_pedido_item_controle`, `cozinha_autorizacoes_qty`, `cozinha_reducoes_teto`, `cozinha_idempotencia`.

## Evidência (Cenário B)

- Contagens antes = depois (todas as tabelas).
- 3 registros de idempotência (DESPACHO_LOTE, AUTORIZAR_QTY, REDUZIR_TETO) idênticos após migração.
- IDs de `cozinha_rodadas` / `cozinha_itens` inalterados.
- Log: `Migração schema v2 → v3 concluída (cozinha_idempotencia: 3 registro(s) preservado(s)).`

## Evidência (Cenário C — falha)

Após `simularFalha: 'apos_copia'`:

- Versão permanece **2**.
- Contagens e conteúdo idênticos ao pré-migração.
- CHECK antigo permanece (rejeita PREPARACAO_INICIADA).
- Cozinha `operacional=false`.

Nenhuma alteração injustificada de conteúdo.
