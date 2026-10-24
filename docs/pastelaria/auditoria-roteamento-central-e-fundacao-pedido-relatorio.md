# Auditoria do roteamento da Central de Entradas e fundação do Pedido

**Projeto:** CDS Sistemas — Pastelaria  
**Tipo:** auditoria estática, somente leitura  
**Escopo:** fluxo NF-e → Compra/estoque e ciclo Pedido → Venda/Faturamento  
**Conclusão:** não foram implementadas funcionalidades ou corrigidos defeitos nesta sprint.

## 1. Síntese executiva

O fluxo de entrada da NF-e não depende apenas da separação entre telas de produto comercial e insumo. A Central persiste o documento, processa o XML pelo parser e MIIP/MIP, permite revisar pendências e abrir a compra. Na confirmação de uma compra originada na Central, cada item deve ter um `tipo_operacional` explícito (`COMERCIAL` ou `INSUMO`) e exatamente uma resolução: produto existente ou criação expressamente solicitada. O serviço da compra valida o tipo contra o produto associado e grava itens/estoque através dos serviços existentes. Isso permite uma NF-e mista e bloqueia diversos conflitos, mas não elimina a possibilidade de o usuário confirmar uma classificação errada ou de um matching heurístico selecionar um item incorreto.

O Pedido já é uma entidade operacional persistida com seus itens, estados, ownership por empresa e reserva de disponibilidade fiscal via Motor Comercial. Ele não é uma venda concluída: faturamento delega a criação da venda ao Núcleo de Vendas; pagamento/financeiro, consumo definitivo de estoque e ficha técnica são tratados na camada de venda. Emissão fiscal fica numa etapa posterior. Há transações locais, mas a sequência venda → consumo de reservas → atualização final do Pedido não é comprovadamente atômica nem plenamente idempotente.

## 2. Fluxo A — NF-e da entrada à movimentação

### 2.1 Mapa do percurso real

| Etapa | Comportamento comprovado | Evidências |
|---|---|---|
| Recepção/persistência do documento | Classifica o XML e extrai chave e metadados; rejeita falta de chave; evita duplicidade por chave + empresa; persiste XML/documento e estado inicial (`XML_COMPLETO` ou `RESUMO_RECEBIDO`). Documento já registrado em Compra pode ser marcado `IMPORTADA`. | `CentralDfePersistenciaService.persistirDocumentoDfe()`, `backend/motores/central-entradas/services/CentralDfePersistenciaService.js:118-136,203-390` |
| Parse do XML | `NFeParserService.parse()` valida e interpreta o conteúdo, delegando ao parser NF-e. O mapper gera itens com nome (`xProd`), GTIN/EAN, NCM, CEST, CFOP, unidade, quantidade, preço unitário e subtotal. | `backend/shared/nfe/NFeParserService.js:25-48`; `backend/shared/nfe/mappers/nfeXmlMapper.js:40-60` |
| Enriquecimento de identidade | `enriquecerParseComMiip()` chama MIIP, associa eventual `produto_id`, cria sugestão e marca pendências. Falha de MIIP é registrada sem descartar o parse. | `backend/shared/nfe/enriquecerParseComMiip.js:75-114` |
| Estado de revisão | Com pendências, o documento fica `AGUARDANDO_REVISAO`; sem pendências, `PRONTA_PARA_COMPRA`. | `CentralProcessamentoService.processar()`, `backend/motores/central-entradas/services/CentralProcessamentoService.js:321-343` |
| Revisão | A rota recebe os itens revisados e `concluirRevisao()` atualiza o parse e transita `AGUARDANDO_REVISAO → REVISADA → PRONTA_PARA_COMPRA`. | `backend/rotas/central-entradas.js:1301-1320`; `CentralComprasBridgeService.concluirRevisao()`, `backend/motores/central-entradas/services/CentralComprasBridgeService.js:246-309` |
| Abertura da Compra | A rota chama `abrirCompra()`. A ponte aceita estados prontos/revisados/em compra, muda para `EM_COMPRA` e monta payload com os itens do parse, XML, CFOP, natureza da operação e empresa. | `backend/rotas/central-entradas.js:1340-1357`; `CentralComprasBridgeService.registrarAberturaCompra()`, `backend/motores/central-entradas/services/CentralComprasBridgeService.js:148-244` |
| Confirmação/classificação | Se a origem for Central NF-e, cada item requer tipo operacional permitido e exatamente uma resolução: `produto_id` ou `criar_produto=true`. Falta de classificação/vínculo é rejeitada antes de gravar. | `backend/rotas/compras.js:1495-1542` |
| Resolução de produto | A ordem auditada é ID explícito, MIP se habilitado, MIIP e fallback legado por código/código de barras/nome. Criação explícita para item da Central cria sem fazer outra busca e preserva a classificação informada. | `ensureProductForItem()` e `ensureProductForItemLegado()`, `backend/rotas/compras.js:448-510,502-601` |
| Persistência e estoque | A rota abre `BEGIN IMMEDIATE`, insere Compra, processa itens, persiste quantidades/preços/subtotais/dados fiscais e de conversão, chama a porta pública de crédito de estoque e finaliza a transação. A quantidade de estoque usa o resultado da conversão MUC quando aplicável. | `backend/rotas/compras.js:650-818,1625-1735`; `backend/services/compras/creditoEstoqueCompraViaPorta.js:111-145` |
| Vínculo de volta à Central | Após a gravação da Compra, registra o vínculo documento-compra, valida a mesma empresa e atualiza o documento para `GRAVADA`. Esse vínculo ocorre após o `COMMIT` da Compra. | `backend/rotas/compras.js:1720-1745,1815-1840`; `CentralComprasBridgeService`, `backend/motores/central-entradas/services/CentralComprasBridgeService.js:311-395` |

### 2.2 Identidade, classificação e roteamento por item

O parser fornece atributos de identificação e quantidades. A procura não é só por nome: a confirmação considera ID explícito, MIP/MIIP e fallback por código, código de barras e nome. Não encontrei evidência suficiente nos pontos auditados para afirmar que o código de item do fornecedor (`cProd`) seja, de ponta a ponta, uma identidade estável priorizada e validada; esse caso deve ser coberto por teste explícito antes de depender dele.

A classificação operacional é requerida na confirmação de cada linha da Central. Um produto já encontrado deve ter tipo compatível; divergência gera `CLASSIFICACAO_ITEM_NFE_DIVERGENTE`. Se o item for criado, a operação explícita preserva o tipo escolhido. Portanto:

- **Produto existente `COMERCIAL`:** deve ser associado ao cadastro comercial correspondente e confirmado como `COMERCIAL`; mismatch é bloqueado.
- **Produto existente `INSUMO`:** deve ser associado ao cadastro de insumo correspondente e confirmado como `INSUMO`; mismatch é bloqueado.
- **Item novo:** confirmação sem `criar_produto=true` é bloqueada; com criação explícita, o tipo escolhido determina o registro criado.
- **Item ambíguo:** MIIP/MIP pode sugerir correspondências e manter pendência para revisão. O fluxo exige decisão de tipo/vínculo na confirmação, mas não há garantia de que a decisão humana seja semanticamente correta.
- **NF-e mista:** é suportada em princípio porque a classificação é validada por item; não existe exigência de que todo o documento tenha um único tipo.

Uma classificação não é silenciosamente alterada para satisfazer a compra: a correspondência com o tipo diferente é rejeitada. Porém, item novo pode ser criado no destino operacional errado se a classificação explícita for escolhida incorretamente. Nome, unidade ou embalagem por si só não são evidência suficiente para uma classificação segura.

### 2.3 Valores, quantidade, impostos e empresa

O mapper citado preserva nome, GTIN/EAN, NCM, CEST, CFOP, unidade comercial/tributável quando presentes no XML, quantidade, preço unitário e subtotal. A compra mantém dados de item, classificação fiscal, conversão, embalagem e metadados de custo. O crédito do estoque recebe quantidades fiscal e não fiscal depois do tratamento de conversão.

**Limite da evidência:** não foi comprovada neste percurso uma preservação integral, sem transformação, de todos os grupos de imposto do XML até cada coluna de `compras_itens`. A sprint posterior deve comparar os campos efetivamente mapeados e persistidos, inclusive impostos por item, com fixtures XML fiscais representativas; não presumir que armazenar CFOP/NCM equivale a preservar todos os tributos.

`empresaId` participa da persistência do DF-e e do processamento; a confirmação da Compra e o vínculo com o documento são associados à empresa, com validação no vínculo. Os testes relevantes de ownership isolam chave e documento por empresa. O modelo, portanto, tem controles em cada trecho citado, mas uma revisão posterior deve manter a empresa explícita em toda chamada e revalidar ownership no ponto de confirmação.

### 2.4 Cenário fictício solicitado

**Refrigerante 2 L, existente como `COMERCIAL`:** XML → parse com descrição/GTIN/quantidade/preço → possível associação MIIP/MIP → revisão quando houver pendência → confirmação exige tipo `COMERCIAL` e produto existente compatível → item de Compra e crédito de estoque após conversão. O código prova o comportamento por classe, não que o exemplo nominal sempre encontre o cadastro correto.

**Farinha, existente como `INSUMO`:** o mesmo pipeline de identidade é usado; na confirmação exige `INSUMO`, e o tipo do produto ligado precisa ser compatível. O fluxo de compra não deve derivar preço de venda/markup para insumo; o teste de classificação cobre a criação e o crédito. A unidade/quantidade efetivamente creditada passa pelo tratamento MUC.

**Óleo, ainda não cadastrado:** se não tiver correspondência válida, a confirmação precisa receber decisão explícita de criação e tipo; sem `criar_produto=true`, não prossegue. Com criação, pode ser criado como `COMERCIAL` ou `INSUMO`, conforme escolha da linha. Esse mecanismo impede criação silenciosa, mas permite erro humano de destino; um match heurístico incorreto também deve ser resolvido na revisão antes da confirmação.

## 3. Matriz de risco e garantias da Entrada

| Risco/questão | Resultado da auditoria | Evidência/observação |
|---|---|---|
| Matching apenas por nome | Não. Há ID, MIP, MIIP e fallback por código/barcode/nome. | `backend/rotas/compras.js:502-601` |
| Código específico do fornecedor como identidade confiável | Não comprovado de ponta a ponta. | Mapper e fallback auditados não demonstram a garantia estável para `cProd`; precisa de teste/contrato. |
| Tipo alterado silenciosamente | Não no caminho de confirmação da Central: classificação é obrigatória e incompatibilidade é rejeitada. | `backend/rotas/compras.js:1495-1542,613-628` |
| Item novo no destino incorreto | Possível se o usuário escolher o tipo errado; criação explícita preserva a escolha, não a valida semanticamente. | `ensureProductForItemLegado()`, `backend/rotas/compras.js:448-510` |
| Duplicação do mesmo item | Há deduplicação/identidade por mecanismos MIP/MIIP e rejeição de documento/compra duplicada, mas não foi provado que qualquer ambiguidade de código de fornecedor seja resolvida sem duplicação. | Testes de classificação e isolamento de chave abaixo. |
| Dupla movimentação | A gravação normal ocorre dentro do fluxo transacional e há controles de duplicidade/estado. A janela após commit, antes do vínculo de retorno à Central, é não atômica entre os dois subsistemas e merece idempotência/reconciliação explícita. | `backend/rotas/compras.js:1695-1840` |
| Atualização parcial | Falhas cobertas antes do commit levam a rollback na transação de Compra; o vínculo/estado da Central é posterior e pode falhar separadamente. | Mesmas referências acima. |
| NF-e e Compra em empresas diferentes | O vínculo valida a empresa, além de persistência/contexto por empresa. | `CentralComprasBridgeService.js:311-395`; testes de ownership. |

## 4. Fluxo B — ciclo de vida do Pedido

### 4.1 Fonte de verdade e contratos persistidos

`pedidos` é a tabela do cabeçalho e `pedidos_itens` contém suas linhas; `PedidoRepository` é o acesso principal ao armazenamento. Os campos principais do pedido incluem ID/código/data, cliente, `total`, `desconto`, `status`, operador, `venda_id`, `empresa_id` e dados de faturamento. Cada item contém `pedido_id`, `produto_id`, `quantidade`, `preco_unitario`, `desconto_percentual`, `subtotal` e `tipo_venda`.

Referências: `backend/database.js:3661-3701`; `backend/services/pedido/PedidoRepository.js:157-243`.

`pedidos_itens` não registra snapshot de `tipo_operacional`, receita/ficha técnica, insumos consumidos, pagamento ou lote. O Pedido referencia produto por ID. Assim, o tipo atual do catálogo pode ser consultado posteriormente, mas não há, no contrato auditado, classificação histórica independente registrada na linha.

### 4.2 Serviços, estados e transições

Existem duas fachadas com operações de criação/reserva semelhantes:

- `PedidoService` declara-se como criação/consulta, sem conclusão da venda. Implementa normalização, fila, consulta e criação/reserva: `backend/services/pedido/PedidoService.js:1-214`.
- As rotas atuais delegam a `PedidoOperacionalService`, que implementa criação, edição, cancelamento, exclusão/duplicação, conversão e envio ao faturamento: `backend/services/pedido/PedidoOperacionalService.js:193-528`; `backend/rotas/pedidos.js:17-148`.

Estados encontrados: `ORCAMENTO`, `PEDIDO`, `ABERTO`, `EM_SEPARACAO`, `AGUARDANDO_FATURAMENTO`, `FATURADO` e `CANCELADO`. A regra `statusExigeConfirmacaoFiscal` exige reserva para `PEDIDO`, `ABERTO`, `EM_SEPARACAO` e `AGUARDANDO_FATURAMENTO`.

- **Orçamento:** persiste sem análise/reserva fiscal.
- **Pedido operacional confirmado:** valida empresa/itens, calcula total, analisa disponibilidade, persiste Pedido/itens e confirma reserva pelo Motor Comercial. Falha tenta liberar reservas e cancelar o Pedido.
- **Edição:** substitui cabeçalho/itens localmente em transação e trata as reservas no serviço operacional.
- **Cancelamento:** bloqueia Pedido faturado; repetição de cancelamento é tratada como sucesso; libera reservas e atualiza status. Liberação e mudança de estado não formam uma única transação abrangendo o Motor Comercial.
- **Faturamento:** requer Pedido pertencente à empresa, não faturado e em estado permitido; delega a criação de venda ao Núcleo, relaciona a venda e marca Pedido como faturado.

Referências: `PedidoOperacionalService.js:131-138,193-394`; `PedidoRepository.js:184-406`; `FaturamentoService.faturarPedido()`, `backend/services/faturamento/FaturamentoService.js:192-325`.

### 4.3 Pedido, tipo operacional e snapshot

As normalizações de item do Pedido carregam produto/quantidade/preço/desconto/subtotal; o schema de item não tem `tipo_operacional`. A reserva do Motor Comercial agrupa e analisa por produto/quantidade, sem composição de receita. Não foi localizada validação explícita no caminho de criação do Pedido que exija `tipo_operacional=COMERCIAL`.

**Divergência importante para a fundação do Pedido:** a invariável de que Pedido representa venda comercial precisa ser validada contra o cadastro no momento de criar/editar a linha. Recomenda-se manter também um snapshot imutável do tipo no item do Pedido, nulo para registros legados, para explicar a decisão operacional histórica caso o cadastro do produto seja alterado no futuro. Essa recomendação não autoriza reclassificar produtos existentes nem mudar a semântica de pedidos históricos.

### 4.4 Responsabilidades e baixa física

| Componente | Responsabilidade existente | O que não deve ser reconstruído |
|---|---|---|
| Pedido / `PedidoOperacionalService` | Fonte operacional de itens e estado do Pedido; valida contexto/ownership; registra total e solicita análise/confirmação de reserva fiscal. | Não deve criar venda, pagamento, emissão fiscal ou consumir ficha técnica já na criação. |
| `PedidoRepository` | Persistência transacional local do cabeçalho/itens, leitura, status e marcação de faturado. | Não é o orquestrador de estoque, receita ou finanças. |
| Motor Comercial | Analisa disponibilidade fiscal e confirma/libera reserva; sob lock/transação reanalisa e pode transferir saldo não fiscal autorizado para fiscal antes de reservar. | Reserva não é baixa definitiva; não deve ser duplicada por outro fluxo de Pedido. |
| Faturamento / Núcleo de Vendas | Converte Pedido permitido em payload de venda e invoca `criarVendaComContexto`; associa `venda_id`/origem e conclui o Pedido. | `FaturamentoService` não emite NF-e; indica `emitir_fiscal: false` e encaminha a etapa fiscal posterior. |
| Estoque | A venda consome a reserva e realiza os efeitos físicos pelo fluxo de venda. | Não baixar no Pedido e novamente no faturamento. |
| Ficha técnica | `VendaPagamentoService` chama consumo da ficha na venda; cancelamento trata o estorno do snapshot da ficha. | Não há prova de que a receita seja expandida/reservada na criação do Pedido. |
| Financeiro | A venda cria dados de pagamento e receitas financeiras. | Criar ou reservar Pedido não cria recebível/receita financeira. |
| Fiscal | Central de Faturamento e serviços fiscais tratam documento posteriormente. | Composição fiscal não altera o total real do Pedido nem executa uma segunda baixa física. |

Referências principais: `backend/motores/comercial/MotorComercialService.js:227-581`; `backend/services/faturamento/FaturamentoService.js:97-140,192-325`; `backend/services/vendas/VendaPagamentoService.js:1013-1024,1140-1142,1354,1720`; `backend/services/vendas/VendaCancelamentoService.js:30-38,114-198,305-406`.

### 4.5 Pedido preparado por ficha técnica

Um Pedido de pastel/refrigerante preparado por receita permanece uma linha do produto comercial em `pedidos_itens`. A tabela de ficha técnica é separada (`backend/database.js:1669-1698`) e o Pedido não grava os componentes nem sua reserva. O consumo de componentes ocorre no ciclo da venda (`VendaPagamentoService.js:1013-1024`); o cancelamento da venda trata estorno (`VendaCancelamentoService.js:30-38,114-198,305-406`).

Para o cenário solicitado, o Pedido pode conter o produto comercial vendido diretamente e o produto comercial preparado por ficha técnica como linhas comerciais. As quantidades de farinha/óleo usadas pela receita são calculadas/consumidas no fluxo da venda, não são comprovadamente linhas de Pedido nem reservas na criação do Pedido. Não há evidência de pagamento ou composição fiscal no Pedido: pagamento/financeiro emerge da venda no faturamento; fiscal segue a etapa posterior.

### 4.6 Empresa, atomicidade e idempotência

A criação exige contexto de empresa em `PedidoService.js:103-110` e `PedidoOperacionalService.js:117-128`; ownership é verificado por `exigirPedidoDaEmpresa` (`PedidoOperacionalService.js:173-190`). Repositório, Motor Comercial e faturamento aplicam `empresa_id` nas operações citadas. O DDL inicial, porém, declara `empresa_id` sem `NOT NULL` (`backend/database.js:3675`); endurecimento complementar está em `backend/utils/pedidosEmpresaHelpers.js:1-204`.

Transações locais comprovadas:

- `PedidoRepository.criarPedido()` — `BEGIN IMMEDIATE`, cabeçalho + itens + `COMMIT`/rollback: `PedidoRepository.js:200-243`.
- Substituição de itens e exclusão de orçamento — transações locais: `PedidoRepository.js:259-318,347-383`.
- Confirmação de reservas — lock/transação e recálculo de disponibilidade no Motor Comercial: `MotorComercialService.js:333-534`.

**Não é uma transação única:** o faturamento primeiro cria a venda, depois associa venda/reservas e marca Pedido faturado. Erro na marcação final pode deixar venda criada e Pedido ainda não faturado; não há chave de idempotência explícita provada em `faturarPedido()`. Repetição pode tentar faturar de novo. Consumo de reservas pode retornar warning e continuar (`FaturamentoService.js:274-292`). Também não foi encontrada prova de que cancelamento da venda reconcilie automaticamente `pedidos.status`/`venda_id`.

## 5. Testes existentes e lacunas

Os testes abaixo foram localizados como evidência da cobertura existente; **não foram executados nesta sprint**, porque o trabalho foi leitura estática e não havia necessidade de ampliar execução além do escopo. A auditoria não abriu o banco operacional, não inicializou processamento fiscal e não chamou SEFAZ.

### Entrada de Compras / Central

- `tests/compras/classificacao-itens-nfe-compra.test.js` — classificação `COMERCIAL`/`INSUMO`, criação/matching, conversão, estoque, duplicidade e rollback.
- `tests/central-entradas/central-entradas-03-xml.test.js` — parse/XML e pipeline Central.
- `tests/central-entradas/central-entradas-04-gate.test.js` — gates de processamento.
- `tests/central-entradas/ownership-documento-05-56.test.js` — vínculo documento/compra.
- `tests/central-entradas/isolamento-chave-compra-05-68.test.js` — isolamento da chave por empresa.
- `tests/central-entradas/homologacao-operacional-central.test.js` — cobertura operacional da Central.

### Pedido / faturamento / estoque

- `tests/faturamento/rc3161-pedido-motor-comercial-mts.test.js`
- `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js`
- `tests/faturamento/rc514-token-uso-unico.test.js`
- `tests/faturamento/rc515-token-escopo.test.js`
- `tests/faturamento/rc521-reserva-reconciliation.test.js`
- `tests/faturamento/rc531-reserva-repair.test.js`
- `tests/faturamento/sprint31-faturamento.test.js`
- `tests/faturamento/sprint314-orcamento-pedidos.test.js`
- `tests/estoque/consumo-reserva-pedido-porta-publica.test.js`
- `tests/estoque/pedido-disponibilidade-multiempresa.test.js`
- `tests/estoque/pedido-expedicao-multiempresa-contexto.test.js`
- `tests/estoque/pedido-mts-disponibilidade-multiempresa.test.js`
- `tests/pedidos/ownership-pedido-reserva-05-49.test.js`

### Lacunas que permanecem

1. Fixture mista end-to-end de uma única NF-e com produto comercial, insumo, novo e ambíguo, cobrindo revisão por linha, vínculo ao mesmo documento e idempotência pós-commit.
2. Evidência completa do código de produto do fornecedor (`cProd`) no parser, MIIP/MIP e deduplicação.
3. Assertions de preservação de todos os componentes de imposto, unidade comercial e unidade tributável desde XML até `compras_itens`.
4. Teste de matching múltiplo/ambíguo que prove não haver escolha automática indevida de produto por nome.
5. Garantia de confirmação/reexecução da Compra e da ponte Central depois de falha entre `COMMIT` da Compra e vínculo do documento.
6. Validação/snapshot de `tipo_operacional` na linha do Pedido; comportamento quando o tipo do produto é alterado depois da criação do Pedido.
7. Idempotência de ponta a ponta para falha após criar a venda e antes de marcar Pedido faturado.
8. Reconciliação do Pedido quando a venda faturada é cancelada.
9. Evidência de reserva dos insumos de receita antes do faturamento. No código auditado, não há essa reserva na criação do Pedido; deve-se decidir explicitamente se isso faz parte do produto, sem duplicar o consumo atual.

## 6. Arquitetura recomendada para próximas sprints

Esta seção é proposta, não implementação aprovada. Manter entregas independentes e validar o contrato antes de migrações.

### Sprint A — Roteamento por item e identidade da NF-e

- Definir DTO por item com identidade original do XML, vínculo ao produto, tipo operacional escolhido, estado de revisão e proveniência da decisão.
- Assegurar revisão explícita de item ambíguo e item novo; preservar classificação de item existente e proibir reclassificação implícita.
- Demonstrar mapeamento de `cProd` e GTIN sem reduzir a busca a nome.
- Arquivos candidatos: `backend/shared/nfe/mappers/nfeXmlMapper.js`; `backend/shared/nfe/enriquecerParseComMiip.js`; `CentralProcessamentoService.js`; `CentralComprasBridgeService.js`; rotas Central; serviços de identidade MIP/MIIP; `tests/compras/classificacao-itens-nfe-compra.test.js` e testes Central.
- Critérios de aceite: fixture mista com todos os tipos/estados; cada item mantém chave/documento/empresa e valores; correspondência incompatível não altera tipo; item ambíguo não é associado automaticamente; duplicidade identificada por identidade contratada.

### Sprint B — Confirmação de Compra, estoque e retomada idempotente

- Mapear limites reais do `BEGIN IMMEDIATE` e efeitos na porta de estoque/financeiro; definir chave de idempotência e reconciliação entre Compra confirmada e estado Central.
- Preservar conversão/unidades/impostos existentes; tornar o retomar após falha seguro sem crédito duplicado.
- Arquivos candidatos: `backend/rotas/compras.js`; `backend/services/compras/creditoEstoqueCompraViaPorta.js`; repositórios/serviços de compra e Central; testes de classificação, ownership e isolamento de chave.
- Critérios de aceite: falhas injetadas antes/depois do commit não causam item/estoque duplicado nem vínculo órfão irrecuperável; confirmação repetida tem resultado determinístico; impostos/unidades têm comparação de fixture.

### Sprint C — Invariantes e histórico do Pedido

- Definir produtos elegíveis para venda e rejeitar insumos como linha de venda quando isso for confirmado como regra do negócio.
- Persistir snapshot não destrutivo de classificação para novos pedidos; tratar pedidos legados sem snapshot sem reclassificá-los.
- Resolver a sobreposição de responsabilidades de `PedidoService` e `PedidoOperacionalService` pelo contrato e uso efetivo, não por refatoração antecipada.
- Arquivos candidatos: `PedidoOperacionalService.js`; `PedidoService.js`; `PedidoRepository.js`; `backend/rotas/pedidos.js`; schema/helpers de pedidos; testes de criação/edição/ownership.
- Critérios de aceite: cada novo item comercial é validado no cadastro; snapshot permanece estável diante de alteração posterior do produto; pedido legado continua legível; total/desconto calculados permanecem invariantes.

### Sprint D — Faturamento, idempotência e cancelamento coordenado

- Introduzir identidade idempotente para conversão Pedido→Venda e reconciliação transacional/saga com estados recuperáveis; a solução não deve depender apenas de novo POST.
- Definir efeito e ordem de reserva, baixa, ficha técnica, financeiro e status do Pedido; fazer cancelamento da venda reconciliar Pedido sem repetir estornos.
- Preservar Motor Comercial, serviços de estoque, ficha técnica, financeiro e fiscal como donos de suas responsabilidades.
- Arquivos candidatos: `backend/services/faturamento/FaturamentoService.js`; `PedidoRepository.js`/`PedidoOperacionalService.js`; `backend/services/vendas/VendaPagamentoService.js`; `VendaCancelamentoService.js`; ponte de reservas do pedido; testes de faturamento, reserva, cancelamento e multiempresa.
- Critérios de aceite: falha em cada fronteira permite retomada sem duplicar venda, baixa, consumo de receita, recebível ou documento; cancelamento repetido reverte somente efeitos aplicados; vínculo Pedido↔Venda mantém consistência.

## 7. Princípios preservados e fora de escopo

O total real pertence ao Pedido/Venda, não à composição fiscal. Reserva fiscal do Motor Comercial não deve ser confundida com baixa de estoque. A venda e sua ficha técnica seguem responsáveis pelo consumo físico e de receita já existente. Financeiro nasce na venda; documento fiscal é etapa posterior. Toda operação deve carregar `empresa_id` explícito e validado. Esta auditoria não alterou nenhum desses fluxos.

## 8. Proteções e encerramento

- Auditoria feita por leitura do código, sem mudanças funcionais ou de schema.
- Não foram executados testes, migrations, consultas ou operações em bancos.
- `C:\ProgramData\MercantilFiscal\dados` não foi acessado, aberto ou migrado.
- Não houve operação real na SEFAZ, consulta/sincronização/manifestação fiscal ou alteração de NSU, cooldown, flags e controles operacionais.
- Não houve reset, rollback destrutivo, commit, push ou merge.
- O workspace já continha alterações não relacionadas, inclusive em componentes da Central de Entradas. Foram preservadas; esta sprint criou somente este relatório.

**Encerramento:** aguardar aprovação do Product Owner e do Tech Lead antes de iniciar qualquer implementação ou ampliar o escopo.
