# Sprint 2A — Contrato de dados e origem do saldo fiscal compartilhado (ml)

Modelagem e auditoria direcionada. Nenhum código, tabela, migração ou dado foi alterado.
Legenda: **[C]** comprovado por leitura · **[I]** inferido · **[D]** decisão pendente de aprovação.

## 1. Arquivos examinados
- `backend/services/vendas/categoriaFiscalEmpresaSchema.js` e `CategoriaFiscalEmpresaService.js` (Sprint 1; existem).
- `backend/services/estoque/estoqueEmpresaSchema.js` (DDL de `estoque_empresa`) e `EstoqueEmpresaService.js` (trecho: validação de `empresa_id`/produto).
- `backend/services/fiscalNaoFiscal/reservasPublico.js` (DDL de `pedido_estoque_reservas`). `estoqueSaldosPublico.js` não foi relido; vale o que a Sprint 0 comprovou.
- `backend/services/produtos/ProdutoConversaoConfigService.js` (`simularConversaoProduto`, `montarRelacoesMuc`) e `produtoConversaoSchema.js` (`muc_produto_relacoes`).
- `backend/motores/muc/index.js` (`obterMuc(db).converterQuantidade`), `core/MotorConversaoQuantidade.js` (`CODIGOS`, `arredondarContrato`) e `core/unidadesSi.js` (`ML`, família VOLUME).
- Buscas exatas por tabelas de movimento/ledger de estoque: **nenhuma** em `fiscalNaoFiscal/` nem `database.js` (`INSERT INTO *movimenta*` sem ocorrência). Existem apenas tabelas de auditoria de domínios específicos (`produto_embalagem_historico`, `nfe_devolucao_*_auditoria`).

## 2. Fatos relevantes
- **[C]** `estoque_empresa`: `UNIQUE(produto_id, empresa_id)`, colunas `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`, `reservado_*` em REAL (arredondamento a 3 casas no serviço). O comentário do schema diz que o armazenamento operacional continua em `produtos`.
- **[C]** O estoque atual **não tem ledger de movimentos** nos pontos examinados: o saldo é alterado diretamente (valor calculado e gravado). Portanto não existe "contrato de movimentos" a reaproveitar; o ledger do saldo lógico é um componente novo.
- **[C]** `pedido_estoque_reservas` guarda só `quantidade_fiscal` por produto, sem unidade e sem chave de idempotência; não serve para reservar ml de grupo.
- **[C]** O MUC converte por produto: `converterQuantidade({quantidade, unidadeOrigem, unidadeDestino, relacoes})` busca um caminho entre unidades; erros `CONVERSAO_INVALIDA`, `CONVERSAO_NAO_DISPONIVEL` e `CONVERSAO_CICLO`. Arredonda só no contrato de saída, a 9 casas (`1e9`). Relações do produto: `muc_produto_relacoes(produto_id, unidade_origem, unidade_destino, fator)`, `UNIQUE` por trio. `simularConversaoProduto` exige `utiliza_conversao = 1` para qualquer conversão entre unidades distintas.
- **[C]** `ML` pertence à família SI VOLUME (fator 0,001 para a base L). Produto cuja unidade de estoque é `UN`→`ML` depende de uma relação de conteúdo cadastrada (comentário em `unidadesSi.js`: "UN→ML é relação de conteúdo, não família SI").
- **[C]** O vínculo produto→categoria (Sprint 1) não comprova validade tributária. **[I]** É somente um filtro de elegibilidade.

## 3. Origem legítima do saldo (alternativas)

**A — Saldo inicial manual autorizado**
- Prós: origem explícita, auditável e sem depender de dados históricos ambíguos. Independe do estado de `produtos.saldo_fiscal`.
- Riscos: erro humano e valor sem lastro documental; exige autorização, motivo e evidência.
- Mitigação: ledger com operador, motivo, referência/documento de conferência, confirmação explícita; só uma abertura por `(empresa, categoria)`; correções por novo movimento de ajuste.

**B — Entradas fiscais documentadas**
- **[C]** Não há, nos arquivos examinados, ligação entre entrada de NF-e e saldo por categoria. **[I]** As entradas (compras/NF-e) existem por produto, mas não foi lido o modelo da entrada que identifique o saldo fiscal creditado por item.
- Risco: somar ml de uma entrada de marca ao grupo pode duplicar o saldo fiscal do produto (que já recebeu a entrada) e depende de `produto` elegível e de conversão MUC inequívoca no momento da entrada.
- Requisitos para o futuro: chave de documento + item como referência única; produto vinculado/elegível na data; conversão MUC válida; decidir se o crédito é automático ou só proposto e aprovado. **[D]**

**C — Migração dos saldos atuais**
- **Não recomendada** (e não foi executada nem simulada em dados oficiais).
- Motivos **[C]**: `produtos.saldo_fiscal` é o saldo físico-fiscal do produto, que continua sendo baixado pela venda e consumido por reservas. Copiá-lo para o grupo cria **dupla contagem** (o mesmo litro existiria no produto e no grupo). Não há ledger para saber o que já foi "contabilizado"; `consultarSaldo` e `_ajustarSaldo` leem fontes diferentes (Sprint 0); produtos sem conversão para ml não têm valor em ml; e `estoque_empresa` é espelho por dual-write.

**Estratégia recomendada: A como única origem inicial; B somente após decisão separada; C descartada.**
Evitar dupla contagem: o saldo lógico é **um controle fiscal à parte**, que não soma nem lê `produtos.saldo_fiscal`; quando for usado (Sprint futura), a venda não pode debitar o mesmo volume duas vezes do saldo do produto e do saldo lógico sem política explícita **[D]**. Cada saldo só nasce por movimento `ABERTURA`, `AJUSTE` ou `ENTRADA_DOCUMENTO` no ledger, com referência.

## 4. Modelo conceitual (sem aplicar)

### `saldo_fiscal_categoria_empresa`
| Campo | Observação |
|---|---|
| `id` | PK |
| `empresa_id` | NOT NULL, FK `empresas` |
| `categoria_fiscal` | CHECK `REFRIGERANTE`/`AGUA` (mesmo enum da Sprint 1) |
| `unidade_base` | fixa `'ML'` (CHECK) |
| `saldo_atual_ml` | INTEGER, não negativo (CHECK) |
| `saldo_reservado_ml` | INTEGER, 0 ≤ reservado ≤ atual (CHECK) |
| `estoque_minimo_ml` | INTEGER, padrão 0 |
| `ativo` | 0/1 |
| `created_at`, `updated_at` | timestamps |
| `UNIQUE(empresa_id, categoria_fiscal)` | isolamento |

Decisões: ml em **inteiro** (ver §5) para evitar erro de ponto flutuante, diferente do REAL de `estoque_empresa`; **reservado como coluna** (padrão já usado em `estoque_empresa.reservado_*`) com detalhe em tabela própria de reservas na Sprint 2B, e disponível = atual − reservado. Estoque mínimo no saldo, pois é por grupo e não existe configuração reutilizável por grupo (hoje só `produtos.estoque_minimo`).

### `saldo_fiscal_categoria_movimentos` (ledger, somente inserção)
| Campo | Observação |
|---|---|
| `id` | PK |
| `empresa_id`, `categoria_fiscal` | chave do saldo |
| `tipo` | `ABERTURA`, `AJUSTE_ENTRADA`, `AJUSTE_SAIDA`, `ENTRADA_DOCUMENTO`, `ESTORNO` (futuros: `RESERVA`, `LIBERACAO_RESERVA`, `CONSUMO`) |
| `direcao` | `+1`/`-1` |
| `quantidade_ml` | INTEGER > 0 (a direção dá o sinal) |
| `saldo_anterior_ml`, `saldo_posterior_ml` | gravados para auditoria (padrão defensivo; o estoque atual não os tem) |
| `origem` | `MANUAL`, `DOCUMENTO`, `SISTEMA` |
| `referencia_tipo`, `referencia_id` | pedido, venda, documento+item, ajuste ou movimento estornado |
| `movimento_estornado_id` | FK para o próprio ledger (estorno não apaga) |
| `idempotency_key` | NOT NULL; `UNIQUE(empresa_id, idempotency_key)` |
| `usuario_id` / `origem_sistemica` | operador ou sistema |
| `produto_id`, `quantidade_origem`, `unidade_origem` | vínculo com o produto original e a conversão usada |
| `motivo`, `metadados_json` | auditoria (inclui `fator_total` e `caminho` do MUC) |
| `created_at` | data/hora |

Ledger imutável (sem UPDATE/DELETE); correções por `ESTORNO`/`AJUSTE`. Cada alteração de `saldo_atual_ml` ocorre na mesma transação que insere o movimento. Justificativa: **não há contrato de movimentos existente** a reaproveitar; reservas atuais (`pedido_estoque_reservas`) não têm unidade nem chave de idempotência.

## 5. Conversão para ml via MUC (estratégia)
1. Ler a configuração do produto (`ProdutoConversaoConfigService.obterConfiguracao`) e verificar vínculo/elegibilidade (`CategoriaFiscalEmpresaService.produtoEhElegivel`) **na mesma empresa**.
2. Chamar o MUC existente com `unidadeDestino: 'ML'` e as relações do produto. Não criar segundo algoritmo.
3. Se o produto não usa conversão e a unidade já é `ML`/`L`, apenas o caminho SI do MUC; se for `UN` sem relação para ML → rejeitar (`CONVERSAO_NAO_DISPONIVEL`). Unidades incompatíveis (ex.: KG→ML) e fatores inválidos rejeitados pelo MUC (`CONVERSAO_INVALIDA`).
4. **Inequívoco**: exigir um único caminho resultante; se o MUC não garantir unicidade em grafos com mais de um caminho, rejeitar por ambiguidade **[D: confirmar o comportamento do MUC em caminhos múltiplos, não verificado]**.
5. **Arredondamento**: o MUC arredonda a 9 casas. O ledger só aceita ml **inteiro**: o resultado deve ser inteiro dentro de tolerância (ex.: 1e-6); caso contrário, rejeitar em vez de arredondar silenciosamente. **[D]** tolerância e política (rejeitar vs. arredondar).
6. Preservar o vínculo: gravar `produto_id`, `quantidade_origem`, `unidade_origem`, `fator_total` e `caminho` no movimento.

## 6. Isolamento, auditoria e idempotência
- Isolamento: toda leitura/escrita filtra por `(empresa_id, categoria_fiscal)`; empresa obrigatória e verificada (padrão `EstoqueEmpresaService`).
- Idempotência: `UNIQUE(empresa_id, idempotency_key)`. Repetir a chave devolve o movimento original sem novo efeito; chave igual com payload diferente → erro.
- Concorrência: operações em `BEGIN IMMEDIATE` (padrão do Motor Comercial), com `UPDATE ... WHERE saldo_atual_ml - saldo_reservado_ml >= ?` e verificação de `changes` — ao contrário do ajuste atual, que lê e grava em JS.
- Saldo negativo: CHECKs no schema e validação no serviço.
- Auditoria: cada movimento com operador, motivo, referência e saldos anterior/posterior; estorno referencia o original.
- Estoque mínimo/alerta: coluna no saldo; avaliação disponível ≤ mínimo fica para sprint própria.

## 7. Decisões que precisam de aprovação
1. Origem inicial exclusivamente por **abertura manual autorizada** (recomendada).
2. Quem pode autorizar e qual evidência/campo de conferência é obrigatório.
3. Permitir ou não `ENTRADA_DOCUMENTO` automática (Alternativa B) e em que sprint.
4. Política para a venda: o consumo do saldo lógico **substitui** ou **complementa** o débito do saldo fiscal do produto (evitar dupla baixa).
5. ml inteiro e tolerância/arredondamento (rejeitar vs. arredondar).
6. Comportamento do MUC com caminhos múltiplos (a verificar antes de implementar).
7. Se desativar produto/vínculo afeta o saldo já aberto.
8. Reaplicar validação tributária (NCM/CFOP/CSOSN) — a elegibilidade da Sprint 1 não a comprova.

## 8. Contrato recomendado para a Sprint 2B (mínimo)
- Schema `saldoFiscalCategoriaSchema.js` (padrão `garantirSchema...Async`, criado sob demanda; sem ligar ao boot nem ao banco oficial) com as duas tabelas da §4 e as constraints.
- Serviço `SaldoFiscalCategoriaService.js` em `backend/services/vendas/`, com:
  - `garantirSaldo({empresaId, categoriaFiscal})`;
  - `registrarAbertura({empresaId, categoriaFiscal, quantidadeMl, usuarioId, motivo, referencia, confirmacao:true, idempotencyKey})` (uma por saldo);
  - `ajustar({..., direcao, quantidadeMl, motivo, usuarioId, idempotencyKey})` e `estornar({movimentoId, motivo, usuarioId, idempotencyKey})`;
  - `obterSaldo({empresaId, categoriaFiscal})` com disponível;
  - `converterParaMl({empresaId, produtoId, quantidade, unidade})` apenas encapsulando o MUC (sem gravar).
- Fora do 2B: reservas, consumo por venda, composição, estoque mínimo/alertas, rotas/telas, qualquer migração de saldos.
- Testes (`:memory:`): abertura única; idempotência; saldo negativo rejeitado; isolamento empresa/categoria; `AGUA`≠`REFRIGERANTE`; ledger imutável com estorno; conversão MUC (caso Coca 1 UN = 1.000 ML, FARDO 12 UN) e rejeições; `produtos`/`estoque_empresa` inalterados.

## 9. Confirmações
Nenhuma tabela foi criada, nenhuma migração aplicada, nenhum saldo, movimento, cadastro, reserva, flag ou configuração alterado. O banco oficial não foi aberto, não houve SEFAZ, nem execução de testes. O único arquivo criado foi este relatório.

## Limitações
Não foi lido o modelo de entrada de compras/NF-e (relevante para a Alternativa B), o `estoqueSaldosPublico.js` além da Sprint 0, nem o comportamento do MUC para múltiplos caminhos.
