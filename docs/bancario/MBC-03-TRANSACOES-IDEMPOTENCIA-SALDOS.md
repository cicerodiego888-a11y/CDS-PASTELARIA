# MBC-03 — Transações, idempotência e saldos conceituais

STATUS: implementado sobre MBC-01 e MBC-02. Sem Open Finance, OFX, conciliação ou vínculo com financeiro/vendas/PIX/TEF.

## 1. STATUS

Concluída. Núcleo de movimentação:

EMPRESA → CONTA BANCÁRIA → TRANSAÇÃO BANCÁRIA

com isolamento, idempotência (quando há identificador externo), imutabilidade operacional e saldo conceitual.

## 2. Arquitetura

A transação pertence à conta. A conta pertence à empresa.

`transacao_bancaria.empresa_id` é persistido e **deve coincidir** com `conta_bancaria.empresa_id`. O service valida essa igualdade. Conta da empresa A + transação da empresa B é recusada (404 se a conta não está no contexto).

Contexto oficial: `BancarioEmpresaContextoService` + `UsuarioEmpresaService`. Sem segundo mecanismo. Sem `empresa_id = 1`. `empresa_id` de body/query não define a empresa.

## 3. Tabela `transacao_bancaria`

Criada em `backend/motores/bancario/schema/bancarioSchema.js`, garantida com o schema MBC em `database.js`.

Não havia tabela oficial de extrato/movimentação/lançamento bancário. O stub de exclusão da MBC-02 passou a usar a tabela real.

## 4. Campos

| Campo | Papel |
| --- | --- |
| `id` | PK |
| `empresa_id` | Isolamento / auditoria (obrigatório) |
| `conta_bancaria_id` | Vínculo obrigatório com a conta |
| `external_source` / `external_id` | Identidade externa (idempotência) |
| `data_transacao` | Data/hora efetiva da origem (nunca `created_at`) |
| `data_processamento` | Opcional; NULL se a origem não informar |
| `valor` | Monetário **positivo**; o sinal vem da direção |
| `direcao` | `entrada`, `saida`, `transferencia` (fundação MBC-01) |
| `descricao` / `tipo` | Texto; tipo controlado (PIX, TED, DOC, BOLETO, CARTAO, TARIFA, TRANSFERENCIA, DEPOSITO, SAQUE, OUTROS) |
| `saldo_apos_transacao` | Informação da origem; **não** alimenta o saldo conceitual |
| `referencia_externa` / `observacao` | Administrativos |
| `raw_reference` | Metadado técnico não sensível (sem token/senha/segredo) |
| `created_at` / `updated_at` | Auditoria de persistência |

## 5. Idempotência

Chave canônica:

`empresa_id` + `conta_bancaria_id` + `external_source` + `external_id`

Índice único **parcial** quando `external_id` está presente.

O mesmo `external_id` pode existir em outra conta, outra empresa ou outro `external_source`.

`registrarTransacao` / `registrarTransacaoBancaria`:

- chave nova → `CRIADA`
- chave existente → `JA_EXISTENTE` (não duplica, não altera, não soma saldo de novo)

Não há PUT genérico. Valor, direção, datas e identificadores são imutáveis nesta sprint.

### Sem `external_id`

O registro é permitido. **Não há idempotência garantida.** Não se inventa chave artificial nem heurística data+valor+descrição (risco de colisão). A resposta traz `idempotencia: false`.

## 6. Isolamento

Listagens e GET por id filtram por `empresa_id` do contexto autorizado. Conta de outra empresa: 404. Query `empresa_id` é ignorada (não é passada ao service).

## 7. APIs

Prefixo `/api/bancario` (permissão `financeiro`):

- `GET /transacoes`
- `GET /transacoes/:id`
- `POST /transacoes`
- `GET /contas/:id/transacoes`
- `GET /contas/:id/saldo`

Filtros: `conta_bancaria_id`, `data_inicio`, `data_fim`, `direcao`, `tipo`. Ordenação: `data_transacao DESC, id DESC`. Limite padrão 100 (máx. 200).

`data_inicio > data_fim` → 400 `Período inválido.`  
Data de calendário inválida → 400.

Empresa do POST vem do contexto + conta. Conta inativa não recebe nova transação (409: `Conta bancária está inativa.`). Consulta histórica permanece.

## 8. Saldo conceitual

**SALDO CONCEITUAL = saldo calculado pelas transações armazenadas no MBC.**

Fórmula desta sprint: `0 + entradas − saídas`.

Sem transações: `0`. Não há saldo inicial automático. Não é “saldo bancário atual”. Não há sincronização com o banco.

`TRANSFERENCIA` não entra como receita/despesa e **não** altera o saldo conceitual nesta sprint (natureza preservada; sem transferência entre contas).

## 9. Diferença: conceitual × bancário

| Conceitual (MBC) | Informado pela origem |
| --- | --- |
| Soma das transações persistidas | `saldo_apos_transacao` |
| Autoridade interna do ERP | Cópia do extrato/provider futuro |
| Não sobrescreve o outro | Não sobrescreve o outro |

## 10. Imutabilidade

Depois de criada, a transação não tem API de alteração de valor, direção, data, fonte, id externo, conta ou empresa. Correção futura exigirá ajuste/estorno (fora desta sprint). Não há edição operacional (observação/referência também sem PUT nesta sprint).

## 11. Conta inativa

Nova transação operacional: 409. Listagem histórica: permitida.

## 12. Exclusão

Conta com transações: 409 `Conta bancária possui transações e não pode ser excluída.` A conta pode ser inativada. Instituição continua protegida pelas regras MBC-02.

## 13. Segurança

Mesmo resolver de empresa da MBC-02. Body `empresa_id` é sobrescrito pelo contexto. Sem credenciais na tabela. `raw_reference` descarta conteúdo que pareça segredo. Tipo `PIX` não vincula o módulo PIX.

## 14. O que não foi implementado

Open Finance, OAuth, consentimento, conexão com bancos, sincronização, OFX, importação de extrato, conciliação, vínculo automático com vendas/financeiro/PIX/TEF, DRE, fluxo de caixa bancário, transferência entre contas, alteração em MIS/MUC/PDV/vendas/compras/caixa.

`IBankProvider` permanece contrato futuro.

## 15. Testes

`tests/bancario/motor-bancario-03.test.js` — T01–T30 + invariante de fronteira.

## 16. Regressão

MBC-01, MBC-02, Financeiro 05.38.D, 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64.

## 17. Arquivos

Ver `IMPLEMENTACAO_MBC_03_RELATORIO.md`.

## 18. Pendências

Homologação visual no browser. Provider real. Conciliação (MBC-04). Saldo inicial oficial, se o negócio exigir.

## 19. Riscos

Registros sem `external_id` podem duplicar se o operador repetir o POST. `TRANSFERENCIA` isolada não move duas contas. Saldo conceitual incompleto se o histórico bancário não for importado (importação é sprint futura).

## 20. Recomendação para MBC-04

Conciliação bancária **manual**: vincular transação já persistida a um título financeiro escolhido pelo usuário, sem adivinhar venda/PIX/TEF e sem conciliação automática.
