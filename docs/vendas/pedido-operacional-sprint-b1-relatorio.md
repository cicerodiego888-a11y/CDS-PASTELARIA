# Sprint Pedido Operacional — Fase B1

## 1) Auditoria inicial

### Estruturas auditadas

- Tabelas: `pedidos`, `pedidos_itens` em `backend/database.js`.
- Serviços: `backend/services/pedido/PedidoService.js`, `backend/services/pedido/PedidoOperacionalService.js`, `backend/services/pedido/PedidoRepository.js`, `backend/services/faturamento/FaturamentoService.js`.
- Fluxos correlatos (estoque/consumo): `backend/services/vendas/VendaPagamentoService.js`, `backend/services/produtos/FichaTecnicaConsumoService.js`, `backend/services/estoque/pedidoReservaPonteNucleo.js`.
- Testes relacionados em `tests/pedidos/`, `tests/faturamento/` e `tests/estoque/`.

### Fluxo observado (antes da alteração)

1. **Criação de pedido/orçamento**: `PedidoOperacionalService.criar` normaliza itens e persiste via `PedidoRepository.criarPedido`; para status comerciais confirma reservas pelo Motor Comercial.
2. **Edição**: `PedidoOperacionalService.atualizar` substitui integralmente os itens (`DELETE + INSERT`) e reconfirma reserva quando aplicável.
3. **Conversão orçamento→pedido**: `converterParaPedido` confirma reserva e muda status.
4. **Cancelamento**: `cancelar` libera reservas e atualiza status para `CANCELADO`.
5. **Faturamento**: `FaturamentoService.faturarPedido` cria venda no núcleo, consome reservas, consome ficha técnica e marca pedido como faturado.

### Lacunas encontradas

- `pedidos_itens` não preservava **snapshot explícito** de classificação operacional (`COMERCIAL`/`INSUMO`) nem identidade mínima do produto (código/nome/unidade) no momento da venda.
- Criação de pedido aceitava `total` informado divergente da soma dos itens (mais ajustes), abrindo brecha de inconsistência entre cabeçalho e itens.
- Pedidos históricos sem classificação no item dependiam implicitamente do catálogo atual, sem sinalização de origem da classificação.

### Tabela de decisão (comportamento atual x desejado x risco x mudança mínima)

| Comportamento atual | Comportamento desejado | Risco de regressão | Mudança mínima aplicada |
|---|---|---|---|
| Item do pedido sem snapshot de classificação e identidade | Item preservar classificação operacional e dados de identidade do produto na criação/edição | Médio (quebrar schemas de teste legados sem novas colunas) | Novas colunas opcionais em `pedidos_itens` + escrita dinâmica compatível com schema antigo |
| Total do pedido pode divergir da soma dos itens | Consistência explícita entre cabeçalho e itens | Baixo-médio (clientes que enviam total incorreto) | Validação com erro `PEDIDO_TOTAL_INCONSISTENTE` em `PedidoService` e `PedidoOperacionalService` |
| Legado sem snapshot não sinaliza origem | Compatibilidade sem reclassificar histórico, com fallback controlado | Baixo | Leitura no repositório expõe `classificacao_operacional` e `classificacao_operacional_origem` (`SNAPSHOT_PEDIDO`/`CATALOGO_ATUAL_LEGADO`) |
| Fluxo de estoque/ficha no faturamento | Manter comportamento atual sem segunda baixa/consumo | Alto se alterar fluxo | **Nenhuma alteração** no fluxo de baixa/consumo/faturamento |

## 2) Implementação realizada

### Arquivos alterados

- `backend/services/pedido/PedidoRepository.js`
- `backend/services/pedido/PedidoOperacionalService.js`
- `backend/services/pedido/PedidoService.js`
- `backend/database.js`
- `tests/pedidos/pedido-operacional-sprint-b1.test.js` (novo)

### Contrato existente versus novo (itens de pedido)

#### Existente (mantido)
- `pedido_id`, `produto_id`, `quantidade`, `preco_unitario`, `desconto_percentual`, `subtotal`, `tipo_venda`.

#### Novo (incremental, sem segundo sistema)
- `classificacao_operacional_snapshot` (TEXT, opcional)
- `produto_codigo_snapshot` (TEXT, opcional)
- `produto_nome_snapshot` (TEXT, opcional)
- `produto_unidade_snapshot` (TEXT, opcional)

### Estratégia de compatibilidade histórica

- **Não houve reclassificação automática** de registros antigos.
- Em leitura (`obterPorId`), quando não existir snapshot:
  - `classificacao_operacional` usa fallback de `produtos.tipo_operacional` (ou `COMERCIAL`);
  - `classificacao_operacional_origem = CATALOGO_ATUAL_LEGADO`.
- Quando houver snapshot:
  - `classificacao_operacional_origem = SNAPSHOT_PEDIDO`.

## 3) Migrações e integridade

### Migrações adicionadas (código)

No `backend/database.js` foram adicionados `ALTER TABLE` seguros para `pedidos_itens`:

- `classificacao_operacional_snapshot`
- `produto_codigo_snapshot`
- `produto_nome_snapshot`
- `produto_unidade_snapshot`

E o `CREATE TABLE IF NOT EXISTS pedidos_itens` passou a incluir as mesmas colunas para bases novas.

### Integridade de empresa

- Mantidas as validações de `empresa_id` existentes no fluxo de Pedido/Faturamento.
- Nenhum fallback global de empresa foi introduzido.

## 4) Estoque e consumo (escopo preservado)

- Não foi criada nova rotina de baixa física.
- Não foi alterado o fluxo de consumo de ficha técnica.
- Não foi alterada a ponte de consumo de reservas do pedido na venda.
- O faturamento continua sem alterar o contrato operacional de preço do pedido.

## 5) Testes executados e resultados reais

## Testes novos/atualizados nesta sprint

1. `tests/pedidos/pedido-operacional-sprint-b1.test.js`  
   - **3 passou, 0 falhou**
   - cobre:
     - preservação de preços/subtotais praticados;
     - snapshot de classificação e identidade;
     - fallback legado sem snapshot;
     - bloqueio de total inconsistente (`PEDIDO_TOTAL_INCONSISTENTE`).

## Regressão executada (relacionada)

2. `tests/pedidos/ownership-pedido-reserva-05-49.test.js`  
   - **10 testes OK** (arquivo reporta 10/10).

3. `tests/faturamento/sprint31-faturamento.test.js`  
   - **exit 0**.

4. `tests/faturamento/rc3161-pedido-motor-comercial-mts.test.js`  
   - **exit 0**.

5. `tests/estoque/consumo-reserva-pedido-porta-publica.test.js`  
   - **10/10 OK**.

6. `tests/estoque/pedido-expedicao-multiempresa-contexto.test.js`  
   - **12/12 OK**.

7. `tests/estoque/pedido-disponibilidade-multiempresa.test.js`  
   - **falhou (1)** com `AssertionError`: esperado `SALDO_INSUFICIENTE`, recebido `PEDIDO_NAO_ENCONTRADO`.
   - O cenário usa `confirmarEstoqueViaMotorComercial` sem persistir pedido e depende de comportamento pré-existente do Motor Comercial.
   - Não foi alterado o núcleo de reservas/baixa nesta sprint; a falha fica registrada como lacuna de regressão existente para revisão separada.

## Checagens complementares

- `node --check` nos arquivos alterados: **OK**.
- `git diff --check`: **OK**.

## 6) Invariantes atendidas nesta sprint

- Pedido mantém valores operacionais praticados por item.
- Itens passam a carregar snapshot de classificação/identidade quando schema suportar.
- Cabeçalho e itens agora têm validação explícita de consistência de total.
- Compatibilidade com pedidos antigos sem snapshot foi preservada sem reclassificação automática.
- Nenhum fluxo fiscal foi iniciado ou acoplado ao pedido operacional nesta fase.

## 7) Riscos/lacunas remanescentes

- Regressão pendente no teste `pedido-disponibilidade-multiempresa` (diferença de erro esperado no caminho sem pedido persistido).
- Como o projeto contém mudanças locais preexistentes em módulos de faturamento/central, a validação completa de toda a matriz de Pedido/Faturamento deve continuar após revisão arquitetural.

## 8) Confirmações de segurança

- Não houve acesso a `%ProgramData%\MercantilFiscal\dados`.
- Não houve abertura de `backend\banco\mercadao.db`.
- Não houve acesso/execução SEFAZ.
- Não foi iniciado ERP contra base operacional.
- Não houve commit/push/merge/reset/checkout destrutivo.
- Não foi introduzida rotina nova de baixa física ou consumo duplicado.
